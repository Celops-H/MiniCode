import { z } from "zod";
import { LOG_LEVELS } from "../logger/index.js";
import { HOOK_EVENT_TYPES } from "../hooks/index.js";

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
  /** 会话存储目录（用户级固定，环境变量 MINICODE_SESSIONS_DIR 可覆盖）；缺省 ~/.minicode/sessions/ */
  sessionsDir: z.string().optional(),
  /** 模型 Provider 列表（多厂商）；未配置回退默认单模型 */
  providers: z.array(providerConfigSchema).optional(),
  /** 优先级链：有序模型 id（ModelRouter 输入），id 须在某 provider 的 models 中 */
  modelChain: z.array(z.string()).optional(),
  /** Hook 配置：事件名 → 命令列表（shell 执行，stdin 收事件 JSON，stdout 回裁决）；未配置则 Hook 系统不启用 */
  hooks: z.partialRecord(z.enum(HOOK_EVENT_TYPES), z.array(z.string())).optional(),
});

export type Config = z.infer<typeof configSchema>;
