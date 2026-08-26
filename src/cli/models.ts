import type { Config } from "../config/index.js";
import { ModelRouter, Models, OpenAICompatibleProvider } from "../llm/index.js";

export const DEFAULT_MODEL = "deepseek-chat";
export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const API_KEY_ENV = "DEEPSEEK_API_KEY";

/**
 * 按配置构建模型客户端：config 配置了 providers → 注册多厂商 Provider，
 * 且配置了 modelChain → 挂 ModelRouter 优先级链路由；未配置 → 回退默认单 DeepSeek 模型。
 * -m 指定时以其为主模型打头（配置的 modelChain 作为备选路由）；-m 未在配置中出现则显式报错，
 * 不静默忽略（修复：providers-only 配置首次对话「未知模型」崩溃、-m 被忽略）。
 * @param config 配置（providers / modelChain 可选）
 * @param modelId 模型 id 覆盖（-m 选项），可省略
 * @returns 注册了 Provider 的 Models 集合
 */
export function buildModelClient(config?: Config, modelId?: string): Models {
  if (config?.providers && config.providers.length > 0) {
    // -m 存在时以其为主模型打头，配置的 modelChain 作备选路由
    const chain = modelId ? [modelId, ...(config.modelChain ?? [])] : config.modelChain;
    const models = new Models({
      router: chain && chain.length > 0 ? new ModelRouter() : undefined,
      chain,
    });
    for (const provider of config.providers) {
      models.register(
        new OpenAICompatibleProvider({
          id: provider.id,
          name: provider.id,
          baseUrl: provider.baseUrl,
          apiKeyEnv: provider.apiKeyEnv,
          // DeepSeek 等推理厂商：thinking 必须回传 reasoning_content，否则工具调用后下一轮 400
          reasoningContent: provider.id === "deepseek",
          // 仅 OpenAI 官方支持 reasoning_effort 请求参数；其余厂商发该字段可能 400，不开
          reasoningEffort: provider.id === "openai",
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
    // 主模型必须可解析：不在配置中则显式报错，避免会话运行时才「未知模型」崩溃
    const main = resolveMainModel(config, modelId);
    if (!models.resolve(main)) {
      throw new Error(`模型 ${main} 未在配置的 providers 中，请检查模型配置或去掉 -m`);
    }
    return models;
  }
  return buildDefaultModelClient(modelId);
}

/**
 * 解析会话主模型：-m 选项 > 优先级链首（modelChain[0]）> providers 首个模型 > 默认模型。
 * 与 buildModelClient 的注册集合保持一致，保证主模型一定可解析。
 * @param config 配置
 * @param modelId -m 选项指定的模型 id，可省略
 * @returns 主模型 id
 */
export function resolveMainModel(config?: Config, modelId?: string): string {
  return modelId ?? config?.modelChain?.[0] ?? config?.providers?.[0]?.models[0]?.id ?? DEFAULT_MODEL;
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
      reasoningContent: true, // DeepSeek 推理模型要求回传 reasoning_content
      models: [{ id, name: id, api: "openai-chat-completions", providerId: "deepseek" }],
    }),
  );
  return models;
}
