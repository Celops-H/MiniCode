import { describe, expect, it } from "vitest";
import { createContext, userMessage } from "../../src/core/index.js";
import type { StreamEvent } from "../../src/core/index.js";
import { AnthropicCompatibleProvider, defaultAnthropicCreateClient, DEFAULT_MAX_TOKENS, REQUEST_TIMEOUT_MS } from "../../src/llm/index.js";
import type { AnthropicMessagesClient, ModelInfo } from "../../src/llm/index.js";

async function* chunkGen(...vals: unknown[]): AsyncIterable<unknown> {
  for (const v of vals) yield v;
}

const MODELS: ModelInfo[] = [
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", api: "anthropic-messages", providerId: "anthropic" },
  { id: "big-context", name: "Big", api: "anthropic-messages", providerId: "anthropic", maxTokens: 4096 },
];

/** Anthropic 原始流式事件样例（与协议层 parseStream 的输入一致） */
const RAW_CHUNKS = [
  { type: "message_start" },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" },
];

function makeProvider(env: NodeJS.ProcessEnv, ...chunks: unknown[]) {
  let lastRequest: Record<string, unknown> | undefined;
  const client: AnthropicMessagesClient = {
    messages: {
      async create(request) {
        lastRequest = request;
        return chunkGen(...chunks);
      },
    },
  };
  const provider = new AnthropicCompatibleProvider({
    id: "zhipu-anthropic",
    name: "GLM（Anthropic 端点）",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    apiKeyEnv: "ZHIPU_API_KEY",
    models: MODELS,
    env,
    createClient: () => client,
  });
  return { provider, getRequest: () => lastRequest };
}

describe("AnthropicCompatibleProvider（anthropic-messages 协议）", () => {
  it("配置了环境变量时已认证，未配置时未认证", () => {
    expect(makeProvider({ ZHIPU_API_KEY: "sk-test" }).provider.auth).toEqual({
      configured: true,
      source: "env",
    });
    expect(makeProvider({}).provider.auth.configured).toBe(false);
  });

  it("返回声明模型列表", () => {
    const { provider } = makeProvider({ ZHIPU_API_KEY: "sk" });
    expect(provider.getModels()).toEqual(MODELS);
  });

  it("组装请求（model + max_tokens + stream）并经协议转成统一事件流", async () => {
    const { provider, getRequest } = makeProvider({ ZHIPU_API_KEY: "sk" }, ...RAW_CHUNKS);
    const events: StreamEvent[] = [];
    for await (const e of provider.stream("claude-sonnet-4-5", createContext("s", [userMessage("q")]))) {
      events.push(e);
    }
    expect(getRequest()).toMatchObject({ model: "claude-sonnet-4-5", max_tokens: DEFAULT_MAX_TOKENS, stream: true });
    // system 提示词在 Anthropic 请求体顶层 system 字段（协议层转换）
    expect(getRequest()).toMatchObject({ system: "s" });
    expect(events).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("max_tokens 取模型定义值（ModelInfo.maxTokens），未定义兜底 8192", async () => {
    const { provider, getRequest } = makeProvider({ ZHIPU_API_KEY: "sk" }, ...RAW_CHUNKS);
    for await (const _ of provider.stream("big-context", createContext("s"))) {
      // 消费流
    }
    expect(getRequest()).toMatchObject({ max_tokens: 4096 });
  });

  it("限定名模型（id 带厂商后缀）请求发原始 vendorId", async () => {
    let lastRequest: Record<string, unknown> | undefined;
    const client: AnthropicMessagesClient = {
      messages: {
        async create(request) {
          lastRequest = request;
          return chunkGen(...RAW_CHUNKS);
        },
      },
    };
    const provider = new AnthropicCompatibleProvider({
      id: "deepseek-anthropic",
      name: "DeepSeek（Anthropic 兼容）",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      env: { DEEPSEEK_API_KEY: "sk" },
      models: [{ id: "deepseek-chat@deepseek-anthropic", vendorId: "deepseek-chat", name: "deepseek-chat", api: "anthropic-messages", providerId: "deepseek-anthropic" }],
      createClient: () => client,
    });
    for await (const _ of provider.stream("deepseek-chat@deepseek-anthropic", createContext("s"))) {
      // 消费流
    }
    // 全局限定名不发给厂商：请求 model 是原始 id
    expect(lastRequest).toMatchObject({ model: "deepseek-chat" });
  });

  it("未配置认证时抛错", async () => {
    const { provider } = makeProvider({});
    const gen = provider.stream("claude-sonnet-4-5", createContext("s"));
    await expect(async () => {
      for await (const _ of gen) {
        // 消费流以触发认证检查
      }
    }).rejects.toThrow();
  });

  it("默认 client 带请求超时（防厂商请求挂起无限等待）", () => {
    const client = defaultAnthropicCreateClient("sk", "https://open.bigmodel.cn/api/anthropic") as unknown as {
      timeout: number;
    };
    expect(client.timeout).toBe(REQUEST_TIMEOUT_MS);
  });
});
