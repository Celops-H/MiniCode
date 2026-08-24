import { describe, expect, it } from "vitest";
import { createContext, userMessage } from "../../src/core/index.js";
import type { StreamEvent } from "../../src/core/index.js";
import { OpenAICompatibleProvider } from "../../src/llm/index.js";
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

  it("未配置认证时抛错", async () => {
    const { provider } = makeProvider({});
    const gen = provider.stream("deepseek-chat", createContext("s"));
    await expect(async () => {
      for await (const _ of gen) {
        // 消费流以触发认证检查
      }
    }).rejects.toThrow();
  });
});
