import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config/index.js";
import { buildModelClient, resolveMainModel } from "../../src/cli/models.js";

describe("buildModelClient（按配置构建模型客户端）", () => {
  it("未配置时回退默认单 DeepSeek 模型", () => {
    const models = buildModelClient();
    expect(models.listModels().map((m) => m.id)).toEqual(["deepseek-chat"]);
    expect(models.resolve("deepseek-chat")).toBeDefined();
  });

  it("配置 providers 时注册多厂商模型", () => {
    const config: Config = {
      logLevel: "info",
      providers: [
        { id: "a", baseUrl: "https://a.example.com", apiKeyEnv: "A_API_KEY", models: [{ id: "a-1" }, { id: "a-2" }] },
        { id: "b", baseUrl: "https://b.example.com", apiKeyEnv: "B_API_KEY", models: [{ id: "b-1" }] },
      ],
    };
    const models = buildModelClient(config);
    expect(models.listModels().map((m) => m.id)).toEqual(["a-1", "a-2", "b-1"]);
    expect(models.resolve("a-1")?.provider.id).toBe("a");
    expect(models.resolve("b-1")?.provider.id).toBe("b");
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
    const models = buildModelClient(config);
    expect(models.resolve("a-1")?.provider.id).toBe("a");
    expect(models.resolve("b-1")?.provider.id).toBe("b");
  });
});

describe("resolveMainModel（主模型解析）", () => {
  it("-m 选项优先于优先级链首，链首优先于默认模型", () => {
    const config: Config = { logLevel: "info", modelChain: ["a-1", "b-1"] };
    expect(resolveMainModel(config, "custom-model")).toBe("custom-model");
    expect(resolveMainModel(config)).toBe("a-1");
    expect(resolveMainModel()).toBe("deepseek-chat");
  });

  it("providers-only（无 modelChain）时主模型为首个模型，可解析（修复未知模型崩溃）", () => {
    const config: Config = {
      logLevel: "info",
      providers: [
        { id: "a", baseUrl: "https://a.example.com", apiKeyEnv: "A_API_KEY", models: [{ id: "a-1" }] },
      ],
    };
    const models = buildModelClient(config);
    expect(resolveMainModel(config)).toBe("a-1");
    expect(models.resolve(resolveMainModel(config))).toBeDefined();
  });

  it("-m 指定配置之外的模型时显式报错，不静默忽略", () => {
    const config: Config = {
      logLevel: "info",
      providers: [
        { id: "a", baseUrl: "https://a.example.com", apiKeyEnv: "A_API_KEY", models: [{ id: "a-1" }] },
      ],
      modelChain: ["a-1"],
    };
    expect(() => buildModelClient(config, "outside-model")).toThrow("未在配置的 providers 中");
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
    const models = buildModelClient(config, "a-2");
    expect(resolveMainModel(config, "a-2")).toBe("a-2");
    expect(models.resolve("a-2")).toBeDefined();
  });
});
