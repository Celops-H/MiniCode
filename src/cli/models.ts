import type { Config } from "../config/index.js";
import { ModelRouter, Models, OpenAICompatibleProvider } from "../llm/index.js";

export const DEFAULT_MODEL = "deepseek-chat";
export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const API_KEY_ENV = "DEEPSEEK_API_KEY";

/**
 * 按配置构建模型客户端：config 配置了 providers → 注册多厂商 Provider，
 * 且配置了 modelChain → 挂 ModelRouter 优先级链路由；未配置 → 回退默认单 DeepSeek 模型。
 * @param config 配置（providers / modelChain 可选）
 * @param modelId 模型 id 覆盖（-m 选项），仅回退默认时生效
 * @returns 注册了 Provider 的 Models 集合
 */
export function buildModelClient(config?: Config, modelId?: string): Models {
  if (config?.providers && config.providers.length > 0) {
    const models = new Models({
      router: config.modelChain ? new ModelRouter() : undefined,
      chain: config.modelChain,
    });
    for (const provider of config.providers) {
      models.register(
        new OpenAICompatibleProvider({
          id: provider.id,
          name: provider.id,
          baseUrl: provider.baseUrl,
          apiKeyEnv: provider.apiKeyEnv,
          models: provider.models.map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            api: "openai-chat-completions",
            providerId: provider.id,
            contextWindow: m.contextWindow,
          })),
        }),
      );
    }
    return models;
  }
  return buildDefaultModelClient(modelId);
}

/**
 * 解析会话主模型：-m 选项 > 优先级链首（modelChain[0]）> 默认模型。
 * @param config 配置
 * @param modelId -m 选项指定的模型 id，可省略
 * @returns 主模型 id
 */
export function resolveMainModel(config?: Config, modelId?: string): string {
  return modelId ?? config?.modelChain?.[0] ?? DEFAULT_MODEL;
}

/** 回退默认：注册单 DeepSeek 模型（无路由） */
function buildDefaultModelClient(modelId?: string): Models {
  const id = modelId ?? DEFAULT_MODEL;
  const models = new Models();
  models.register(
    new OpenAICompatibleProvider({
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: DEFAULT_BASE_URL,
      apiKeyEnv: API_KEY_ENV,
      models: [{ id, name: id, api: "openai-chat-completions", providerId: "deepseek" }],
    }),
  );
  return models;
}
