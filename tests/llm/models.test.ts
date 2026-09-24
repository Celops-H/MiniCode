import { afterEach, describe, expect, it, vi } from "vitest";
import { createContext } from "../../src/core/index.js";
import type { StreamEvent } from "../../src/core/index.js";
import { ModelRouter, Models } from "../../src/llm/index.js";
import type { Provider, ModelInfo } from "../../src/llm/index.js";

afterEach(() => {
  vi.useRealTimers();
});

function makeProvider(id: string, modelIds: string[], reply: string): Provider {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com`,
    auth: { configured: true },
    getModels: () =>
      modelIds.map(
        (mid): ModelInfo => ({ id: mid, name: mid, api: "openai-chat-completions", providerId: id }),
      ),
    async *stream(modelId) {
      yield { type: "text_delta", text: `${reply}:${modelId}` };
      yield { type: "done", stopReason: "stop" };
    },
  };
}

/** 制造一个可注入故障行为的 Provider：failWith 抛指定 HTTP 状态，failMid 先产出事件再抛 */
function makeFaultyProvider(
  id: string,
  modelId: string,
  opts: { failWith?: number; failMid?: boolean; reply?: string } = {},
): Provider {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com`,
    auth: { configured: true },
    getModels: () => [{ id: modelId, name: modelId, api: "openai-chat-completions", providerId: id }],
    async *stream() {
      if (opts.failWith !== undefined) {
        throw Object.assign(new Error(`${id} 失败`), { status: opts.failWith });
      }
      if (opts.failMid) {
        yield { type: "text_delta", text: "partial" };
        throw Object.assign(new Error(`${id} 流中断`), { status: 502 });
      }
      yield { type: "text_delta", text: `${opts.reply ?? id}:${modelId}` };
      yield { type: "done", stopReason: "stop" };
    },
  };
}

describe("Models 集合", () => {
  it("register 后可按 provider id 查找", () => {
    const models = new Models();
    models.register(makeProvider("a", ["a-1"], "A"));
    expect(models.provider("a")?.id).toBe("a");
    expect(models.provider("missing")).toBeUndefined();
  });

  it("listModels 汇总全部 Provider 的模型", () => {
    const models = new Models();
    models.register(makeProvider("a", ["a-1", "a-2"], "A"));
    models.register(makeProvider("b", ["b-1"], "B"));
    expect(models.listModels().map((m) => m.id)).toEqual(["a-1", "a-2", "b-1"]);
  });

  it("resolve 根据模型 id 定位 Provider", () => {
    const models = new Models();
    models.register(makeProvider("a", ["a-1"], "A"));
    models.register(makeProvider("b", ["b-1"], "B"));
    expect(models.resolve("b-1")?.provider.id).toBe("b");
    expect(models.resolve("nope")).toBeUndefined();
  });

  it("stream 路由到对应 Provider", async () => {
    const models = new Models();
    models.register(makeProvider("a", ["a-1"], "A"));
    models.register(makeProvider("b", ["b-1"], "B"));
    const events: StreamEvent[] = [];
    for await (const e of models.stream("b-1", createContext("s"))) events.push(e);
    expect(events).toEqual([
      { type: "text_delta", text: "B:b-1" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("未知模型抛错", async () => {
    const models = new Models();
    models.register(makeProvider("a", ["a-1"], "A"));
    const gen = models.stream("unknown", createContext("s"));
    await expect(async () => {
      for await (const _ of gen) {
        // 消费流以触发路由错误
      }
    }).rejects.toThrow("未知模型");
  });
});

describe("Models 路由（配置 ModelRouter 后）", () => {
  it("主模型可切换失败时切到备选，并记录主模型失败", async () => {
    const router = new ModelRouter();
    const models = new Models({ router, chain: ["main-1", "backup-1"] });
    models.register(makeFaultyProvider("main", "main-1", { failWith: 429 }));
    models.register(makeFaultyProvider("backup", "backup-1"));
    const events: StreamEvent[] = [];
    for await (const e of models.stream("main-1", createContext("s"))) events.push(e);
    // 主模型失败先发 model_fallback 观察事件，再接备选正常产出
    expect(events).toEqual([
      { type: "model_fallback", from: "main-1", to: "backup-1" },
      { type: "text_delta", text: "backup:backup-1" },
      { type: "done", stopReason: "stop" },
    ]);
    expect(router.isHealthy("main-1")).toBe(false);
  });

  it("主模型失败切换备选：发 model_fallback 观察事件（from/to），避免静默路由", async () => {
    const router = new ModelRouter();
    const models = new Models({ router, chain: ["main-1", "backup-1"] });
    models.register(makeFaultyProvider("main", "main-1", { failWith: 429 }));
    models.register(makeFaultyProvider("backup", "backup-1"));
    const events: StreamEvent[] = [];
    for await (const e of models.stream("main-1", createContext("s"))) events.push(e);
    // 切换前先发 model_fallback，再接备选模型的正常产出
    expect(events).toEqual([
      { type: "model_fallback", from: "main-1", to: "backup-1" },
      { type: "text_delta", text: "backup:backup-1" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("401（认证/余额不足）走熔断：recordFailure 冷却主模型、切备选，冷却期不再请求主模型（F-3=60）", async () => {
    const router = new ModelRouter({ cooldownMs: 5_000 });
    const models = new Models({ router, chain: ["openrouter-1", "deepseek-1"] });
    models.register(makeFaultyProvider("openrouter", "openrouter-1", { failWith: 401 }));
    models.register(makeFaultyProvider("deepseek", "deepseek-1"));
    const events: StreamEvent[] = [];
    for await (const e of models.stream("openrouter-1", createContext("s"))) events.push(e);
    // 401 可切换：发 model_fallback 接备选正常产出（对齐 openai 厂商同路径）
    expect(events[0]).toEqual({ type: "model_fallback", from: "openrouter-1", to: "deepseek-1" });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
    // 主模型被 recordFailure 冷却：select 跳过冷却中的它（熔断冷却生效，不立即无脑重试坏 key）
    expect(router.isHealthy("openrouter-1")).toBe(false);
    expect(router.select(["openrouter-1", "deepseek-1"])).toBe("deepseek-1");
  });

  it("401 冷却期内第二次请求：跳过主模型直接走备选，不再请求坏 key（P13 复测观感）", async () => {
    const router = new ModelRouter({ cooldownMs: 60_000 });
    const models = new Models({ router, chain: ["openrouter-1", "deepseek-1"] });
    let openrouterCalls = 0;
    const openrouter = makeFaultyProvider("openrouter", "openrouter-1", { failWith: 401 });
    // 包一层计数：断言冷却期内第二次 stream 不碰主模型
    const counting: Provider = {
      ...openrouter,
      async *stream(modelId, context, options) {
        openrouterCalls++;
        yield* openrouter.stream(modelId, context, options);
      },
    };
    models.register(counting);
    models.register(makeFaultyProvider("deepseek", "deepseek-1"));

    // 第一次：401 → 切备选，主模型被冷却
    const first: StreamEvent[] = [];
    for await (const e of models.stream("openrouter-1", createContext("s"))) first.push(e);
    expect(first[0]).toEqual({ type: "model_fallback", from: "openrouter-1", to: "deepseek-1" });
    expect(openrouterCalls).toBe(1);

    // 冷却期内第二次：select 直接跳过主模型，主模型一次都没被请求；轮开始跳过也发
    // model_fallback 观察事件（署名与提示跟实际产出者，批次 18 review 补）
    const second: StreamEvent[] = [];
    for await (const e of models.stream("openrouter-1", createContext("s"))) second.push(e);
    expect(openrouterCalls).toBe(1); // 坏 key 模型零重试
    expect(second[0]).toEqual({ type: "model_fallback", from: "openrouter-1", to: "deepseek-1" });
    expect(second.at(-1)).toEqual({ type: "done", stopReason: "stop" });
  });

  it("传入 modelId 不在配置链时以其打头（/@/model 切到链外模型生效）", async () => {
    const router = new ModelRouter();
    const models = new Models({ router, chain: ["main-1", "backup-1"] });
    models.register(makeFaultyProvider("main", "main-1"));
    models.register(makeFaultyProvider("backup", "backup-1"));
    models.register(makeFaultyProvider("pick", "picked-1"));
    // stream 传入 picked-1（不在 chain 里）：路由链应以它为头，首选即 picked-1
    const events: StreamEvent[] = [];
    for await (const e of models.stream("picked-1", createContext("s"))) events.push(e);
    expect(events[0]).toEqual({ type: "text_delta", text: "pick:picked-1" });
    // main-1 未被触达（健康保持，证明没有退回链首）
    expect(router.isHealthy("main-1")).toBe(true);
  });

  it("整链全部失败时抛最后的错误", async () => {
    const models = new Models({ router: new ModelRouter(), chain: ["main-1", "backup-1"] });
    models.register(makeFaultyProvider("main", "main-1", { failWith: 429 }));
    models.register(makeFaultyProvider("backup", "backup-1", { failWith: 503 }));
    const events: StreamEvent[] = [];
    await expect(async () => {
      for await (const e of models.stream("main-1", createContext("s"))) events.push(e);
    }).rejects.toThrow("backup 失败");
    // 备选也失败后 select 全挂兜底返回链首（已尝试）：不发「已切换 main-1」的虚假通知
    expect(events).toEqual([{ type: "model_fallback", from: "main-1", to: "backup-1" }]);
  });

  it("不可切换错误直接上抛，不切备选且不计数", async () => {
    const router = new ModelRouter();
    const models = new Models({ router, chain: ["main-1", "backup-1"] });
    models.register(makeFaultyProvider("main", "main-1", { failWith: 400 }));
    models.register(makeFaultyProvider("backup", "backup-1", { failWith: 500 })); // 若被切换会抛 500，证明未切
    await expect(async () => {
      for await (const _ of models.stream("main-1", createContext("s"))) {
        // 消费流以触发路由错误
      }
    }).rejects.toThrow("main 失败");
    expect(router.isHealthy("main-1")).toBe(true); // 400 不计数，主仍健康
  });

  it("流已开始响应后失败不切换模型（避免混流）", async () => {
    const router = new ModelRouter();
    const models = new Models({ router, chain: ["main-1", "backup-1"] });
    models.register(makeFaultyProvider("main", "main-1", { failMid: true }));
    models.register(makeFaultyProvider("backup", "backup-1")); // 若切换会成功，证明未切
    const received: StreamEvent[] = [];
    await expect(async () => {
      for await (const e of models.stream("main-1", createContext("s"))) {
        received.push(e);
      }
    }).rejects.toThrow("main 流中断");
    expect(received).toEqual([{ type: "text_delta", text: "partial" }]); // 保留已产出部分
    expect(router.isHealthy("main-1")).toBe(true); // 流中断不计数
  });

  it("用户打断（signal 已中止）直接上抛，不切备选不标冷却", async () => {
    const router = new ModelRouter();
    const models = new Models({ router, chain: ["main-1", "backup-1"] });
    // 无 HTTP 状态的可切换类错误；abort 在请求前已触发（Ctrl+C 一个 token 都没回的场景）
    const networkProvider: Provider = {
      id: "main",
      name: "main",
      baseUrl: "https://main.example.com",
      auth: { configured: true },
      getModels: () => [{ id: "main-1", name: "main-1", api: "openai-chat-completions", providerId: "main" }],
      async *stream() {
        throw new Error("network down");
      },
    };
    models.register(networkProvider);
    models.register(makeFaultyProvider("backup", "backup-1")); // 若被切换会成功，证明未切
    const controller = new AbortController();
    controller.abort();
    await expect(async () => {
      for await (const _ of models.stream("main-1", createContext("s"), { signal: controller.signal })) {
        // 消费流触发路由
      }
    }).rejects.toThrow("network down");
    expect(router.isHealthy("main-1")).toBe(true); // 打断不计数，主模型不误标冷却
  });

  it("流以 error 事件结束不记路由成功（健康度不虚标）", async () => {
    vi.useFakeTimers();
    const router = new ModelRouter({ cooldownMs: 5_000, confirmCount: 2 });
    const models = new Models({ router, chain: ["main-1"] });
    const errorProvider: Provider = {
      id: "main",
      name: "main",
      baseUrl: "https://main.example.com",
      auth: { configured: true },
      getModels: () => [{ id: "main-1", name: "main-1", api: "openai-chat-completions", providerId: "main" }],
      async *stream() {
        yield { type: "error", message: "厂商报错" };
      },
    };
    models.register(errorProvider);
    // 先制造一次失败进入冷却，冷却到期后半开放行（真实请求试探）
    router.recordFailure("main-1");
    vi.advanceTimersByTime(5_001);
    // 半开放行后跑两次错误流：若误记成功会推进成功连击，达 confirm 阈值即恢复健康
    for (let i = 0; i < 2; i++) {
      const events: StreamEvent[] = [];
      for await (const e of models.stream("main-1", createContext("s"))) events.push(e);
      expect(events[0]).toMatchObject({ type: "error" });
    }
    expect(router.isHealthy("main-1")).toBe(false); // error 流不计成功，仍不健康
  });

  it("流以 error 收尾且未产出内容：记失败进冷却，下次请求直接路由到健康备选（E57）", async () => {
    const router = new ModelRouter({ cooldownMs: 60_000 });
    const models = new Models({ router, chain: ["main-1", "backup-1"] });
    const errorProvider: Provider = {
      id: "main",
      name: "main",
      baseUrl: "https://main.example.com",
      auth: { configured: true },
      getModels: () => [{ id: "main-1", name: "main-1", api: "openai-chat-completions", providerId: "main" }],
      async *stream() {
        yield { type: "error", message: "流意外结束" };
      },
    };
    models.register(errorProvider);
    models.register(makeFaultyProvider("backup", "backup-1"));
    // 第一次：未产出内容以 error 收尾 → 记 recordFailure 进冷却（E57 前永不冷却，每次都先撞一遍）
    const first: StreamEvent[] = [];
    for await (const e of models.stream("main-1", createContext("s"))) first.push(e);
    expect(first[0]).toMatchObject({ type: "error" });
    expect(router.isHealthy("main-1")).toBe(false);
    // 第二次：冷却期内直接路由到备选
    const second: StreamEvent[] = [];
    for await (const e of models.stream("main-1", createContext("s"))) second.push(e);
    expect(second[0]).toEqual({ type: "model_fallback", from: "main-1", to: "backup-1" });
    expect(second.at(-1)).toEqual({ type: "done", stopReason: "stop" });
  });

  it("流以 error 收尾但已产出内容（半截响应）：不误标失败（E57）", async () => {
    const router = new ModelRouter();
    const models = new Models({ router, chain: ["main-1"] });
    const partialErrorProvider: Provider = {
      id: "main",
      name: "main",
      baseUrl: "https://main.example.com",
      auth: { configured: true },
      getModels: () => [{ id: "main-1", name: "main-1", api: "openai-chat-completions", providerId: "main" }],
      async *stream() {
        yield { type: "text_delta", text: "半截" };
        yield { type: "error", message: "流中断" };
      },
    };
    models.register(partialErrorProvider);
    for await (const _ of models.stream("main-1", createContext("s"))) {
      // 消费流
    }
    expect(router.isHealthy("main-1")).toBe(true); // 半截响应不记失败
  });

  it("链上不可解析条目跳过继续下一个，两次切换都有观察事件（E54）", async () => {
    const router = new ModelRouter();
    const models = new Models({ router, chain: ["main-1", "ghost-1", "backup-1"] });
    models.register(makeFaultyProvider("main", "main-1", { failWith: 429 }));
    models.register(makeFaultyProvider("backup", "backup-1"));
    const events: StreamEvent[] = [];
    for await (const e of models.stream("main-1", createContext("s"))) events.push(e);
    // 主模型 429 → select 落到不可解析的 ghost-1 → 跳过 → 备选正常产出
    expect(events).toEqual([
      { type: "model_fallback", from: "main-1", to: "ghost-1" },
      { type: "model_fallback", from: "ghost-1", to: "backup-1" },
      { type: "text_delta", text: "backup:backup-1" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("整链尝试完后抛最后的真实错误，不被「未知模型」遮蔽（E54）", async () => {
    const models = new Models({ router: new ModelRouter(), chain: ["main-1", "ghost-1", "backup-1"] });
    models.register(makeFaultyProvider("main", "main-1", { failWith: 429 }));
    models.register(makeFaultyProvider("backup", "backup-1", { failWith: 503 }));
    await expect(async () => {
      for await (const _ of models.stream("main-1", createContext("s"))) {
        // 消费流以触发路由
      }
    }).rejects.toThrow("backup 失败");
  });

  it("整链全部不可解析时抛「未知模型」，不发自我切换的虚假事件（E54 review 补）", async () => {
    const models = new Models({ router: new ModelRouter(), chain: ["ghost-1"] });
    models.register(makeProvider("a", ["a-1"], "A"));
    const events: StreamEvent[] = [];
    await expect(async () => {
      for await (const e of models.stream("ghost-1", createContext("s"))) events.push(e);
    }).rejects.toThrow("未知模型");
    // select 全挂兜底返回链首（自身）：不发「已切换 ghost-1」
    expect(events).toEqual([]);
  });

  it("单条目链真实失败：不发自我切换事件，直接上抛真实错误（review 补既有路径）", async () => {
    const models = new Models({ router: new ModelRouter(), chain: ["main-1"] });
    models.register(makeFaultyProvider("main", "main-1", { failWith: 429 }));
    const events: StreamEvent[] = [];
    await expect(async () => {
      for await (const e of models.stream("main-1", createContext("s"))) events.push(e);
    }).rejects.toThrow("main 失败");
    expect(events).toEqual([]);
  });

  it("真实失败在前、死条目收尾：抛真实厂商错误，不被「未知模型」反向遮蔽（E54 review 补）", async () => {
    const models = new Models({ router: new ModelRouter(), chain: ["main-1", "ghost-1"] });
    models.register(makeFaultyProvider("main", "main-1", { failWith: 429 }));
    const events: StreamEvent[] = [];
    await expect(async () => {
      for await (const e of models.stream("main-1", createContext("s"))) events.push(e);
    }).rejects.toThrow("main 失败");
    // 主模型切到死条目有观察事件；死条目之后无未尝试模型，不再发第二次
    expect(events).toEqual([{ type: "model_fallback", from: "main-1", to: "ghost-1" }]);
  });
});
