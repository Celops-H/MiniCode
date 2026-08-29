import { z } from "zod";
import { LOG_LEVELS } from "../logger/index.js";
import { HOOK_EVENT_TYPES } from "../hooks/index.js";

/** 单个模型配置（OpenAI 兼容厂商的模型）；strict：拼错字段直接报错而非默认忽略 */
export const modelConfigSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    contextWindow: z.number().optional(),
    /** 厂商单次回复输出上限（anthropic-messages 协议请求体必填 max_tokens，取此值兜底 8192） */
    maxTokens: z.number().optional(),
  })
  .strict();
export type ModelConfig = z.infer<typeof modelConfigSchema>;

/** 已实现的协议（配置可选项）；ProtocolType 预留的其余协议未接入装配，不开放配置 */
export const PROVIDER_PROTOCOLS = ["openai-chat-completions", "anthropic-messages"] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

/** 单个 Provider 配置（厂商接入）；strict：拼错字段直接报错而非默认忽略 */
export const providerConfigSchema = z
  .object({
    id: z.string(),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string(),
    /** 落盘 API key（/connect 写用户级全局配置，E27）；环境变量 key 同权且优先（E33） */
    apiKey: z.string().optional(),
    /** 协议（缺省 openai-chat-completions）：装配层按它选 Provider 工厂（BACKEND §5） */
    protocol: z.enum(PROVIDER_PROTOCOLS).optional(),
    models: z.array(modelConfigSchema),
  })
  .strict();
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/** 单个 MCP server 配置（stdio 传输，BACKEND §19）；strict：拼错字段直接报错而非默认忽略 */
export const mcpServerConfigSchema = z
  .object({
    /** 启动命令（如 npx、node） */
    command: z.string(),
    /** 命令参数列表 */
    args: z.array(z.string()).optional(),
    /** 注入子进程的额外环境变量（在继承环境之上追加） */
    env: z.record(z.string(), z.string()).optional(),
    /** 工具调用超时毫秒（缺省 60000） */
    timeoutMs: z.number().optional(),
    /** 启用开关（缺省 true）：关闭的 server 装配时跳过不启动 */
    enabled: z.boolean().optional(),
  })
  .strict();
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

/** Skill 技能配置（BACKEND §20）；strict：拼错字段直接报错而非默认忽略 */
export const skillsConfigSchema = z
  .object({
    /** 关闭名单：命中技能名的技能不注入系统提示词（全局/项目两层名单取并集） */
    disabled: z.array(z.string()).optional(),
  })
  .strict();
export type SkillsConfig = z.infer<typeof skillsConfigSchema>;

/** 配置 schema：config 模块是 schema 单一权威，随功能演进扩展字段；strict：未知字段直接报错（DESIGN 16） */
export const configSchema = z
  .object({
    logLevel: z.enum(LOG_LEVELS).default("info"),
  /** 会话存储目录（用户级固定，环境变量 MINICODE_SESSIONS_DIR 可覆盖）；缺省 ~/.minicode/sessions/ */
  sessionsDir: z.string().optional(),
  /** 模型 Provider 列表（多厂商）；未配置回退默认单模型 */
  providers: z.array(providerConfigSchema).optional(),
  /** 优先级链：有序模型 id（ModelRouter 输入），id 须在某 provider 的 models 中 */
  modelChain: z.array(z.string()).optional(),
  /** Hook 配置：事件名 → 命令列表（shell 执行，stdin 收事件 JSON，stdout 回裁决）；未配置则 Hook 系统不启用 */
  hooks: z.partialRecord(z.enum(HOOK_EVENT_TYPES), z.array(z.string())).optional(),
  /** 上下文压缩配置：撞线自动压缩 + /compact 手动压缩；未配置则压缩不启用 */
  compact: z
    .object({
      /** 模型上下文窗口 token；缺省用模型定义值，模型也没有则默认 128000 */
      contextWindow: z.number().optional(),
      /** 保留给模型回复输出的 token，默认 8192 */
      maxOutputTokens: z.number().default(8192),
      /** 安全余量 token：预留避免撞线，默认 4096 */
      safetyMargin: z.number().default(4096),
      /** 历史裁剪保留最近的工具结果条数，默认 5 */
      keepRecentToolResults: z.number().default(5),
    })
    .optional(),
  /** MCP 外部工具服务（BACKEND §19）：服务名 → stdio 启动配置；装配时启动并接入工具池，
   *  全局/项目按服务名归并（load 层例外逻辑，同 providers 按 id 合并） */
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
  /** Skill 技能配置（BACKEND §20）：disabled 关闭名单，全局/项目两层取并集 */
  skills: skillsConfigSchema.optional(),
})
  .strict();

export type Config = z.infer<typeof configSchema>;
