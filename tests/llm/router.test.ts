import { afterEach, describe, expect, it, vi } from "vitest";
import { isSwitchableError, ModelRouter } from "../../src/llm/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("isSwitchableError（可切换错误分类）", () => {
  it("限流（429）可切换", () => {
    expect(isSwitchableError({ status: 429 })).toBe(true);
  });

  it("服务器错误（5xx）可切换", () => {
    expect(isSwitchableError({ status: 500 })).toBe(true);
    expect(isSwitchableError({ status: 502 })).toBe(true);
    expect(isSwitchableError({ status: 503 })).toBe(true);
  });

  it("请求超时（408）与锁冲突（409）可切换", () => {
    expect(isSwitchableError({ status: 408 })).toBe(true);
    expect(isSwitchableError({ status: 409 })).toBe(true);
  });

  it("无 HTTP 状态（网络/连接/超时错误）可切换", () => {
    expect(isSwitchableError(new Error("fetch failed"))).toBe(true);
  });

  it("认证/余额不足（401）可切换——用户定论 A：切不可用模型自动路由（备选可能跨厂商、不同 key）", () => {
    expect(isSwitchableError({ status: 401 })).toBe(true);
  });

  it("参数（400）/权限（403）错误不可切换，直接报错", () => {
    expect(isSwitchableError({ status: 400 })).toBe(false);
    expect(isSwitchableError({ status: 403 })).toBe(false);
  });

  it("模型不存在（404）不可切换", () => {
    expect(isSwitchableError({ status: 404 })).toBe(false);
  });
});

describe("ModelRouter（路由状态与选择）", () => {
  it("select 按优先级链返回首个健康模型", () => {
    const router = new ModelRouter();
    expect(router.select(["a", "b"])).toBe("a");
  });

  it("select 跳过冷却未到期的模型，选下一个健康模型", () => {
    vi.useFakeTimers();
    const router = new ModelRouter({ cooldownMs: 5_000 });
    router.recordFailure("a");
    expect(router.select(["a", "b"])).toBe("b");
  });

  it("冷却到期后半开放行：select 重新选中该模型", () => {
    vi.useFakeTimers();
    const router = new ModelRouter({ cooldownMs: 5_000 });
    router.recordFailure("a");
    vi.advanceTimersByTime(5_001);
    expect(router.select(["a", "b"])).toBe("a");
  });

  it("全挂兜底：整链都在冷却时返回链首", () => {
    vi.useFakeTimers();
    const router = new ModelRouter({ cooldownMs: 5_000 });
    router.recordFailure("a");
    router.recordFailure("b");
    expect(router.select(["a", "b"])).toBe("a"); // 链首在冷却中也返回，最后尝试
  });

  it("连续失败达阈值熔断：短冷却结束后仍不可用，熔断期过后才恢复", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const router = new ModelRouter({ cooldownMs: 1_000, circuitBreakerMs: 10_000, maxFailures: 3 });
    router.recordFailure("a");
    router.recordFailure("a");
    router.recordFailure("a"); // 第 3 次达阈值 → 熔断 10s
    vi.advanceTimersByTime(2_000); // 短冷却(1s)已过，熔断(10s)未到
    expect(router.select(["a", "b"])).toBe("b");
    vi.advanceTimersByTime(8_000); // 满 10s 熔断期
    expect(router.select(["a", "b"])).toBe("a");
  });

  it("失败未达阈值时短冷却到期即恢复", () => {
    vi.useFakeTimers();
    const router = new ModelRouter({ cooldownMs: 1_000, maxFailures: 3 });
    router.recordFailure("a"); // 第 1 次失败，短冷却
    vi.advanceTimersByTime(1_001);
    expect(router.select(["a", "b"])).toBe("a");
  });

  it("恢复确认：熔断恢复后连续成功达阈值才算完全健康", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const router = new ModelRouter({ cooldownMs: 1_000, confirmCount: 2 });
    router.recordFailure("a");
    expect(router.isHealthy("a")).toBe(false);
    vi.advanceTimersByTime(1_001); // 冷却到期（半开）
    router.recordSuccess("a"); // 试探成功，连击 1，仍未完全健康
    expect(router.isHealthy("a")).toBe(false);
    expect(router.select(["a", "b"])).toBe("a"); // 半开恢复中仍可用
    router.recordSuccess("a"); // 连击 2，达阈值完全健康
    expect(router.isHealthy("a")).toBe(true);
  });

  it("失败打破恢复确认连击，需重新累计成功", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const router = new ModelRouter({ cooldownMs: 1_000, confirmCount: 2 });
    router.recordFailure("a");
    vi.advanceTimersByTime(1_001);
    router.recordSuccess("a"); // 连击 1
    router.recordFailure("a"); // 失败打破连击，重新冷却
    vi.advanceTimersByTime(1_001);
    router.recordSuccess("a"); // 重新连击 1，未达阈值
    expect(router.isHealthy("a")).toBe(false);
    router.recordSuccess("a"); // 连击 2
    expect(router.isHealthy("a")).toBe(true);
  });
});
