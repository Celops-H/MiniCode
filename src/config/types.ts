import { z } from "zod";
import { LOG_LEVELS } from "../logger/index.js";

/** 单个模型配置（OpenAI 兼容厂商的模型） */
export const modelConfigSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  contextWindow: z.number().optional(),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

/** 单个 Provider 配置（OpenAI 兼容厂商） */
export const providerConfigSchema = z.object({
  id: z.string(),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string(),
  models: z.array(modelConfigSchema),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/** 配置 schema：config 模块是 schema 单一权威，随功能演进扩展字段 */
export const configSchema = z.object({
  logLevel: z.enum(LOG_LEVELS).default("info"),
  /** 模型 Provider 列表（多厂商）；未配置回退默认单模型 */
  providers: z.array(providerConfigSchema).optional(),
  /** 优先级链：有序模型 id（ModelRouter 输入），id 须在某 provider 的 models 中 */
  modelChain: z.array(z.string()).optional(),
});

export type Config = z.infer<typeof configSchema>;
