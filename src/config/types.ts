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
    /** 推理系列模型（支持思考输出）：思考类请求参数（reasoning_effort/enable_thinking）
     *  仅对推理系列模型随思考等级下发——同一厂商混排思考/非思考模型，对不支持的模型
     *  照发会被厂商 400 拒绝（E60） */
    reasoning: z.boolean().optional(),
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
    /** API 端点。两种拼接约定不同：openai-chat-completions 需含 /v1（SDK 在其下追加
     *  /chat/completions）；anthropic-messages 不带 /v1（SDK 自动追加 /v1/messages），
     *  多写会请求到 /v1/v1/messages 404（E67）。不做自动归一化（猜前缀风险大于收益） */
    baseUrl: z.string().url(),
    apiKeyEnv: z.string(),
    /** 落盘 API key（/connect 写用户级全局配置，E27）；环境变量 key 同权且优先（E33） */
    apiKey: z.string().optional(),
    /** 协议（缺省 openai-chat-completions）：装配层按它选 Provider 工厂（BACKEND §5） */
    protocol: z.enum(PROVIDER_PROTOCOLS).optional(),
    /** 端点按 Anthropic 官方语义强制校验 thinking 块签名（仅 anthropic-messages 协议，
     *  E61）：为 true 时请求带 tools 期间不发 thinking 参数，避免真 Anthropic API 对
     *  无签名历史 thinking 块的二轮 400；GLM/Kimi/DeepSeek 兼容端点不校验，缺省 false */
    requireThinkingSignature: z.boolean().optional(),
    /** 推理厂商（DeepSeek 等）：assistant 思考回传为 reasoning_content 字段，工具调用后
     *  必须回传否则厂商 400；有思考内容才发，缺省 false。仅 openai-chat-completions
     *  协议有意义（anthropic 协议不消费，E60） */
    reasoningContent: z.boolean().optional(),
    /** 支持 reasoning_effort 请求参数的厂商（OpenAI 系）：随思考等级仅对 reasoning 模型
     *  下发，其余厂商或非推理模型发该字段可能 400（E60）。仅 openai-chat-completions
     *  协议有意义 */
    reasoningEffort: z.boolean().optional(),
    /** 需显式 enable_thinking 参数才开启思考的厂商（DashScope）：随思考等级仅对
     *  reasoning 模型发送，否则思考等级静默无效（E60）。仅 openai-chat-completions
     *  协议有意义 */
    enableThinking: z.boolean().optional(),
    /** 请求流式真实用量（stream_options.include_usage，E63）：支持的厂商开启后流尾
     *  回传 token 用量挂 done.usage。个别严格网关对未知参数 400 且不可切换，故为
     *  能力位开关而非无条件发送；仅 openai-chat-completions 协议有意义 */
    includeUsage: z.boolean().optional(),
    /** 附加请求头，经 SDK defaultHeaders 透传（Azure OpenAI 的 api-key 认证头、
     *  anthropic-beta 等，E64） */
    headers: z.record(z.string(), z.string()).optional(),
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

/** 调试开关（诊断用，E68）；strict：拼错字段直接报错而非默认忽略 */
export const debugConfigSchema = z
  .object({
    /** 记录 openai 流解析中未产出任何事件的被丢弃 chunk（数量 + 样本，流结束时输出到
     *  stderr），排查「流活跃但零输出」的静默卡死；诊断输出会干扰 TUI 画面，仅排查时开启 */
    streamChunks: z.boolean().optional(),
  })
  .strict();
export type DebugConfig = z.infer<typeof debugConfigSchema>;

/** 配置 schema：config 模块是 schema 单一权威，随功能演进扩展字段；strict：未知字段直接报错（DESIGN 16） */
export const configSchema = z
  .object({
    logLevel: z.enum(LOG_LEVELS).default("info"),
  /** 会话存储根目录（按启动工作目录分子目录，DESIGN 14）；缺省 ~/.minicode/sessions/ */
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
  /** 调试开关（诊断用，E68）：默认全关，零行为影响 */
  debug: debugConfigSchema.optional(),
})
  .strict();

export type Config = z.infer<typeof configSchema>;
