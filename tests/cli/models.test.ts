import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config/index.js";
import { buildModelClient, resolveMainModel } from "../../src/cli/models.js";

const KEYS = { A_API_KEY: "k-a", B_API_KEY: "k-b" };

describe("buildModelClient（按配置构建模型客户端）", () => {
  it("配置 providers 时注册多厂商模型", () => {
    const config: Config = {
      logLevel: "info",
      providers: [
        { id: "a", baseUrl: "https://a.example.com", apiKeyEnv: "A_API_KEY", models: [{ id: "a-1" }, { id: "a-2" }] },
        { id: "b", baseUrl: "https://b.example.com", apiKeyEnv: "B_API_KEY", models: [{ id: "b-1" }] },
      ],
    };
    const models = buildModelClient(config, undefined, { env: KEYS });
    expect(models.listModels().map((m) => m.id)).toEqual(["a-1", "a-2", "b-1"]);
    expect(models.resolve("a-1")?.provider.id).toBe("a");
    expect(models.resolve("b-1")?.provider.id).toBe("b");
  });

  it("key 未配置的厂商不注册（列表里出现的模型一定有 key）", () => {
    const config: Config = {
      logLevel: "info",
      providers: [
        { id: "a", baseUrl: "https://a.example.com", apiKeyEnv: "A_API_KEY", models: [{ id: "a-1" }] },
        { id: "b", baseUrl: "https://b.example.com", apiKeyEnv: "B_API_KEY", models: [{ id: "b-1" }] },
      ],
    };
    const models = buildModelClient(config, undefined, { env: { A_API_KEY: "k-a" } });
    expect(models.listModels().map((m) => m.id)).toEqual(["a-1"]);
    expect(models.resolve("b-1")).toBeUndefined();
  });

  it("可用厂商为零时显式报错，不再回退硬编码兜底", () => {
    const config: Config = {
      logLevel: "info",
      providers: [{ id: "a", baseUrl: "https://a.example.com", apiKeyEnv: "A_API_KEY", models: [{ id: "a-1" }] }],
    };
    expect(() => buildModelClient(config, undefined, { env: {} })).toThrow("未配置任何可用厂商");
    expect(() => buildModelClient(undefined, undefined, { env: KEYS })).toThrow("未配置任何可用厂商");
  });

  it("protocol 为 anthropic-messages 时注册 Anthropic 协议 Provider，缺省仍走 openai 兼容", () => {
    const config: Config = {
      logLevel: "info",
      providers: [
        {
          id: "glm-anthropic",
          baseUrl: "https://open.bigmodel.cn/api/anthropic",
          apiKeyEnv: "ZHIPU_API_KEY",
          protocol: "anthropic-messages",
          models: [{ id: "glm-4-plus" }],
        },
        {
          id: "deepseek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          models: [{ id: "deepseek-chat" }],
        },
      ],
    };
    const models = buildModelClient(config, undefined, { env: { ZHIPU_API_KEY: "k", DEEPSEEK_API_KEY: "k" } });
    expect(models.resolve("glm-4-plus")?.model.api).toBe("anthropic-messages");
    expect(models.resolve("deepseek-chat")?.model.api).toBe("openai-chat-completions");
  });

  it("配置 modelChain 时优先级链成员都能解析到对应 provider", () => {
    const config: Config = {
      logLevel: "info",
      providers: [
        { id: "a", baseUrl: "https://a.example.com", apiKeyEnv: "A_API_KEY", models: [{ id: "a-1" }] },
        { id: "b", baseUrl: "https://b.example.com", apiKeyEnv: "B_API_KEY", models: [{ id: "b-1" }] },
      ],
      modelChain: ["a-1", "b-1"],
    };
    const models = buildModelClient(config, undefined, { env: KEYS });
    expect(models.resolve("a-1")?.provider.id).toBe("a");
    expect(models.resolve("b-1")?.provider.id).toBe("b");
  });
});

describe("resolveMainModel（主模型解析）", () => {
  it("-m 选项优先于优先级链首，链首优先于 providers 首个模型", () => {
    const config: Config = { logLevel: "info", modelChain: ["a-1", "b-1"] };
    expect(resolveMainModel(config, "custom-model")).toBe("custom-model");
    expect(resolveMainModel(config)).toBe("a-1");
  });

  it("providers-only（无 modelChain）时主模型为首个模型，可解析（修复未知模型崩溃）", () => {
    const config: Config = {
      logLevel: "info",
      providers: [
        { id: "a", baseUrl: "https://a.example.com", apiKeyEnv: "A_API_KEY", models: [{ id: "a-1" }] },
      ],
    };
    const models = buildModelClient(config, undefined, { env: KEYS });
    expect(resolveMainModel(config, undefined, { env: KEYS })).toBe("a-1");
    expect(models.resolve(resolveMainModel(config, undefined, { env: KEYS }))).toBeDefined();
  });

  it("无 -m、无 modelChain、无 providers 时报错（无默认模型兜底）", () => {
    expect(() => resolveMainModel(undefined)).toThrow("未配置任何可用厂商");
    expect(() => resolveMainModel({ logLevel: "info" })).toThrow("未配置任何可用厂商");
  });

  it("首位厂商无 key 时主模型回落 key 就绪厂商的首个模型（播种后只配一个 key 的常见路径）", () => {
    const config: Config = {
      logLevel: "info",
      providers: [
        { id: "openai", baseUrl: "https://a.example.com", apiKeyEnv: "OPENAI_API_KEY", models: [{ id: "gpt-4o" }] },
        { id: "deepseek", baseUrl: "https://b.example.com", apiKeyEnv: "DEEPSEEK_API_KEY", models: [{ id: "deepseek-chat" }] },
      ],
    };
    // 只配了 DEEPSEEK_API_KEY：主模型必须是 deepseek-chat 而非未注册的 gpt-4o
    expect(resolveMainModel(config, undefined, { env: { DEEPSEEK_API_KEY: "k" } })).toBe("deepseek-chat");
    const models = buildModelClient(config, undefined, { env: { DEEPSEEK_API_KEY: "k" } });
    expect(models.resolve(resolveMainModel(config, undefined, { env: { DEEPSEEK_API_KEY: "k" } }))).toBeDefined();
  });

  it("跨厂商同 id 模型：先注册者用原始 id，后注册者以「模型id@厂商id」限定名区分，各自路由正确", () => {
    const config: Config = {
      logLevel: "info",
      providers: [
        { id: "deepseek", baseUrl: "https://a.example.com", apiKeyEnv: "A", models: [{ id: "deepseek-chat" }] },
        { id: "deepseek-anthropic", baseUrl: "https://b.example.com", apiKeyEnv: "A", protocol: "anthropic-messages", models: [{ id: "deepseek-chat" }] },
      ],
    };
    const env = { A: "k" };
    const models = buildModelClient(config, undefined, { env });
    const ids = models.listModels().map((m) => m.id);
    expect(ids).toContain("deepseek-chat");
    expect(ids).toContain("deepseek-chat@deepseek-anthropic");
    expect(models.resolve("deepseek-chat")?.provider.id).toBe("deepseek");
    expect(models.resolve("deepseek-chat@deepseek-anthropic")?.provider.id).toBe("deepseek-anthropic");
  });

  it("-m 指定配置之外的模型时显式报错，不静默忽略", () => {
    const config: Config = {
      logLevel: "info",
      providers: [
        { id: "a", baseUrl: "https://a.example.com", apiKeyEnv: "A_API_KEY", models: [{ id: "a-1" }] },
      ],
      modelChain: ["a-1"],
    };
    expect(() => buildModelClient(config, "outside-model", { env: KEYS })).toThrow("模型 outside-model 不可用");
  });

  it("-m 指定配置内的模型时可用，并作为主模型", () => {
    const config: Config = {
      logLevel: "info",
      providers: [
        {
          id: "a",
          baseUrl: "https://a.example.com",
          apiKeyEnv: "A_API_KEY",
          models: [{ id: "a-1" }, { id: "a-2" }],
        },
      ],
      modelChain: ["a-1"],
    };
    const models = buildModelClient(config, "a-2", { env: KEYS });
    expect(resolveMainModel(config, "a-2")).toBe("a-2");
    expect(models.resolve("a-2")).toBeDefined();
  });
});

describe("落盘 apiKey 与环境变量同权（E33）", () => {
  const storedConfig: Config = {
    logLevel: "info",
    providers: [
      {
        id: "stored",
        baseUrl: "https://stored.example.com",
        apiKeyEnv: "STORED_API_KEY",
        apiKey: "stored-key",
        models: [{ id: "m-1" }],
      },
    ],
  };

  it("无环境变量时仅凭配置 apiKey 即注册可用，主模型可解析", () => {
    const models = buildModelClient(storedConfig, undefined, { env: {} });
    expect(models.resolve("m-1")).toBeDefined();
    expect(resolveMainModel(storedConfig, undefined, { env: {} })).toBe("m-1");
  });

  it("环境变量与落盘 key 同时存在：环境变量优先（auth.source=env）", () => {
    const models = buildModelClient(storedConfig, undefined, { env: { STORED_API_KEY: "env-key" } });
    const provider = models.provider("stored");
    expect(provider?.auth).toEqual({ configured: true, source: "env" });
  });

  it("落盘 key 与环境变量皆无：不注册（零可用走启动引导/报错路径）", () => {
    const bare: Config = {
      logLevel: "info",
      providers: [
        {
          id: "stored",
          baseUrl: "https://stored.example.com",
          apiKeyEnv: "STORED_API_KEY",
          models: [{ id: "m-1" }],
        },
      ],
    };
    expect(() => buildModelClient(bare, undefined, { env: {} })).toThrow();
    expect(() => resolveMainModel(bare, undefined, { env: {} })).toThrow();
  });
});
