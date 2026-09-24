import { describe, expect, it, vi } from "vitest";
import { createContext, userMessage } from "../../src/core/index.js";
import type { StreamEvent } from "../../src/core/index.js";
import { defaultCreateClient, OpenAICompatibleProvider, REQUEST_TIMEOUT_MS } from "../../src/llm/index.js";
import type { ChatCompletionsClient, ModelInfo } from "../../src/llm/index.js";
async function* chunkGen(...vals: unknown[]): AsyncIterable<unknown> {
  for (const v of vals) yield v;
}

const MODELS: ModelInfo[] = [
  { id: "deepseek-chat", name: "DeepSeek Chat", api: "openai-chat-completions", providerId: "deepseek" },
];

function makeProvider(env: NodeJS.ProcessEnv, ...chunks: unknown[]) {
  let lastRequest: Record<string, unknown> | undefined;
  const client: ChatCompletionsClient = {
    chat: {
      completions: {
        async create(request) {
          lastRequest = request;
          return chunkGen(...chunks);
        },
      },
    },
  };
  const provider = new OpenAICompatibleProvider({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: MODELS,
    env,
    createClient: () => client,
  });
  return { provider, getRequest: () => lastRequest };
}

describe("认证解析", () => {
  it("配置了环境变量时已认证", () => {
    const { provider } = makeProvider({ DEEPSEEK_API_KEY: "sk-test" });
    expect(provider.auth).toEqual({ configured: true, source: "env" });
  });

  it("未配置环境变量时未认证", () => {
    const { provider } = makeProvider({});
    expect(provider.auth.configured).toBe(false);
  });
});

describe("getModels", () => {
  it("返回声明模型列表", () => {
    const { provider } = makeProvider({ DEEPSEEK_API_KEY: "sk" });
    expect(provider.getModels()).toEqual(MODELS);
  });
});

describe("stream", () => {
  it("组装请求（model + stream）并经协议转成统一事件流", async () => {
    const { provider, getRequest } = makeProvider(
      { DEEPSEEK_API_KEY: "sk" },
      { choices: [{ delta: { content: "hi" }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
    );
    const events: StreamEvent[] = [];
    for await (const e of provider.stream("deepseek-chat", createContext("s", [userMessage("q")]))) {
      events.push(e);
    }
    expect(getRequest()).toMatchObject({ model: "deepseek-chat", stream: true });
    expect(events).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("限定名模型（id 带厂商后缀）请求发原始 vendorId", async () => {
    let lastRequest: Record<string, unknown> | undefined;
    const client: ChatCompletionsClient = {
      chat: {
        completions: {
          async create(request) {
            lastRequest = request;
            return chunkGen({ choices: [{ delta: { content: "hi" }, index: 0 }] });
          },
        },
      },
    };
    const provider = new OpenAICompatibleProvider({
      id: "deepseek-anthropic",
      name: "DeepSeek（Anthropic 兼容）",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      env: { DEEPSEEK_API_KEY: "sk" },
      models: [{ id: "deepseek-chat@deepseek-anthropic", vendorId: "deepseek-chat", name: "deepseek-chat", api: "openai-chat-completions", providerId: "deepseek-anthropic" }],
      createClient: () => client,
    });
    for await (const _ of provider.stream("deepseek-chat@deepseek-anthropic", createContext("s"))) {
      // 消费流
    }
    // 全局限定名不发给厂商：请求 model 是原始 id
    expect(lastRequest).toMatchObject({ model: "deepseek-chat" });
  });

  it("debugDroppedChunks 透传协议层（E68 接线）：装配开关打开时零产出 chunk 输出诊断", async () => {
    const client: ChatCompletionsClient = {
      chat: {
        completions: {
          async create() {
            return chunkGen(
              { choices: [{ delta: { role: "assistant" }, index: 0 }] },
              { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
            );
          },
        },
      },
    };
    const provider = new OpenAICompatibleProvider({
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      env: { DEEPSEEK_API_KEY: "sk" },
      models: MODELS,
      debugDroppedChunks: true,
      createClient: () => client,
    });
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((line: unknown) => {
      writes.push(String(line));
      return true;
    }) as typeof process.stderr.write);
    try {
      for await (const _ of provider.stream("deepseek-chat", createContext("s"))) {
        // 消费流
      }
    } finally {
      spy.mockRestore();
    }
    // 零产出 2 个：仅 role 的 chunk 与 finish_reason 收尾 chunk（无工具打开时不产出事件）
    expect(writes.join("")).toContain("2 个未产出任何事件");
  });

  it("未配置认证时抛错", async () => {
    const { provider } = makeProvider({});
    const gen = provider.stream("deepseek-chat", createContext("s"));
    await expect(async () => {
      for await (const _ of gen) {
        // 消费流以触发认证检查
      }
    }).rejects.toThrow("请设置环境变量 DEEPSEEK_API_KEY");
  });
});

describe("请求超时", () => {
  it("默认 client 带请求超时（防厂商请求挂起无限等待）", () => {
    const client = defaultCreateClient("sk", "https://api.deepseek.com") as unknown as { timeout: number };
    expect(client.timeout).toBe(REQUEST_TIMEOUT_MS);
  });

  it("默认 client 关闭 SDK 内置重试（E58：失败转移由 ModelRouter 独占，不叠加静默重试）", () => {
    const client = defaultCreateClient("sk", "https://api.deepseek.com") as unknown as { maxRetries: number };
    expect(client.maxRetries).toBe(0);
  });
});

describe("流空闲超时（厂商 SSE 中途静默挂起）", () => {
  /** 挂起流：先产出一个 chunk 后不再产出，直到 signal 中止才释放（模拟厂商断流但连接不关） */
  function hangingStream(signal?: AbortSignal): AsyncIterable<unknown> {
    return {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "hi" }, index: 0 }] };
        await new Promise<void>((resolve) => {
          const onAbort = (): void => resolve();
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
    };
  }

  it("N 秒无新 chunk 时中断底层请求并抛「模型响应超时」，已产出保留", async () => {
    const client: ChatCompletionsClient = {
      chat: {
        completions: {
          async create(_request, options) {
            return hangingStream(options?.signal);
          },
        },
      },
    };
    const provider = new OpenAICompatibleProvider({
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      models: MODELS,
      env: { DEEPSEEK_API_KEY: "sk" },
      streamIdleTimeoutMs: 50, // 测试用短超时
      createClient: () => client,
    });
    const events: StreamEvent[] = [];
    const t0 = Date.now();
    await expect(async () => {
      for await (const e of provider.stream("deepseek-chat", createContext("s", [userMessage("q")]))) {
        events.push(e);
      }
    }).rejects.toThrow(/模型响应超时/);
    // 已产出的第一个 chunk 正常到达；超时异常经协议层补发 error 事件（观测通道）后抛出
    expect(events).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "error", message: expect.stringContaining("模型响应超时") },
    ]);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("不产出事件的 chunk（ping/仅 role）也算活跃：静默思考期不误判超时", async () => {
    // 空闲超时按厂商原始 chunk 计时：首个正文 chunk 后每 40ms 来一个仅 role 的
    // chunk（不产出任何事件），累计 240ms 远超 50ms 超时——若按「事件间隔」计时
    // 会在 50ms 处误判超时；正常完成即锁定了计时层级
    async function* keepaliveStream(): AsyncIterable<unknown> {
      yield { choices: [{ delta: { content: "hi" }, index: 0 }] };
      for (let i = 0; i < 6; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        yield { choices: [{ delta: { role: "assistant" }, index: 0 }] };
      }
      yield { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] };
    }
    const client: ChatCompletionsClient = {
      chat: {
        completions: {
          async create() {
            return keepaliveStream();
          },
        },
      },
    };
    const provider = new OpenAICompatibleProvider({
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      models: MODELS,
      env: { DEEPSEEK_API_KEY: "sk" },
      streamIdleTimeoutMs: 50, // 测试用短超时（小于累计静默、大于相邻 chunk 间隔）
      createClient: () => client,
    });
    const events: StreamEvent[] = [];
    for await (const e of provider.stream("deepseek-chat", createContext("s", [userMessage("q")]))) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("finish_reason 后厂商握着连接不发结束帧：宽限窗后正常收尾 done，不再误报超时（E47）", async () => {
    // 响应已逻辑完整（finish_reason 已到），厂商不发 [DONE] 也不关流：
    // 旧实现 30s 空闲超时报错丢整轮，现在宽限窗耗尽按正常收尾关流
    const client: ChatCompletionsClient = {
      chat: {
        completions: {
          async create(_request, options) {
            return {
              async *[Symbol.asyncIterator]() {
                yield { choices: [{ delta: { content: "hi" }, index: 0 }] };
                yield { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] };
                await new Promise<void>((resolve) => {
                  const onAbort = (): void => resolve();
                  if (options?.signal?.aborted) onAbort();
                  else options?.signal?.addEventListener("abort", onAbort, { once: true });
                });
              },
            };
          },
        },
      },
    };
    const provider = new OpenAICompatibleProvider({
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      models: MODELS,
      env: { DEEPSEEK_API_KEY: "sk" },
      streamIdleTimeoutMs: 50,
      streamTailGraceMs: 60, // 测试用短宽限窗
      createClient: () => client,
    });
    const events: StreamEvent[] = [];
    const t0 = Date.now();
    for await (const e of provider.stream("deepseek-chat", createContext("s", [userMessage("q")]))) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "done", stopReason: "stop" },
    ]);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("finish_reason 后宽限窗内补发的正文不丢（E47）", async () => {
    async function* tailContentStream(signal?: AbortSignal): AsyncIterable<unknown> {
      yield { choices: [{ delta: { content: "hi" }, index: 0 }] };
      yield { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] };
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      yield { choices: [{ delta: { content: "补发" }, index: 0 }] };
      await new Promise<void>((resolve) => {
        const onAbort = (): void => resolve();
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    const client: ChatCompletionsClient = {
      chat: {
        completions: {
          async create(_request, options) {
            return tailContentStream(options?.signal);
          },
        },
      },
    };
    const provider = new OpenAICompatibleProvider({
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      models: MODELS,
      env: { DEEPSEEK_API_KEY: "sk" },
      streamIdleTimeoutMs: 50,
      streamTailGraceMs: 60,
      createClient: () => client,
    });
    const events: StreamEvent[] = [];
    for await (const e of provider.stream("deepseek-chat", createContext("s", [userMessage("q")]))) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "text_delta", text: "补发" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("用户 signal 中止时转发中断底层挂起（打断语义保留，流尽快释放）", async () => {
    let interrupted = false;
    const client: ChatCompletionsClient = {
      chat: {
        completions: {
          async create(_request, options) {
            return {
              async *[Symbol.asyncIterator]() {
                yield { choices: [{ delta: { content: "hi" }, index: 0 }] };
                await new Promise<void>((resolve) => {
                  const onAbort = (): void => {
                    interrupted = true;
                    resolve();
                  };
                  if (options?.signal?.aborted) onAbort();
                  else options?.signal?.addEventListener("abort", onAbort, { once: true });
                });
              },
            };
          },
        },
      },
    };
    const provider = new OpenAICompatibleProvider({
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      models: MODELS,
      env: { DEEPSEEK_API_KEY: "sk" },
      createClient: () => client,
    });
    const controller = new AbortController();
    const iterator = provider
      .stream("deepseek-chat", createContext("s", [userMessage("q")]), {
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual({ type: "text_delta", text: "hi" });
    controller.abort();
    const rest: StreamEvent[] = [];
    let step = await iterator.next();
    while (!step.done) {
      rest.push(step.value);
      step = await iterator.next();
    }
    // 挂起被释放、流正常结束（无 finish_reason）→ parseStream 补发 error「流意外结束」
    expect(interrupted).toBe(true);
    expect(rest.some((e) => e.type === "error")).toBe(true);
  });
});
