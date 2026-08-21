import { describe, expect, it } from "vitest";
import { isSwitchableError } from "../../src/llm/index.js";

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

  it("参数（400）/认证（401）/权限（403）错误不可切换，直接报错", () => {
    expect(isSwitchableError({ status: 400 })).toBe(false);
    expect(isSwitchableError({ status: 401 })).toBe(false);
    expect(isSwitchableError({ status: 403 })).toBe(false);
  });

  it("模型不存在（404）不可切换", () => {
    expect(isSwitchableError({ status: 404 })).toBe(false);
  });
});
