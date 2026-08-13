import { Models, OpenAICompatibleProvider } from "../llm/index.js";

export const DEFAULT_MODEL = "deepseek-chat";
export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const API_KEY_ENV = "DEEPSEEK_API_KEY";

/**
 * 组装模型客户端：默认 DeepSeek（OpenAI 兼容）。
 * @param modelId 模型 id，缺省用 DEFAULT_MODEL
 * @returns 注册了 DeepSeek Provider 的 Models 集合
 */
export function buildModelClient(modelId?: string): Models {
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
