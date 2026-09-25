/**
 * 厂商预设（种子模板）：CLI/TUI 同源共享——全局配置播种按这份列表写 providers，
 * /connect 弹窗按这份列表展示。key 不进预设：只写 baseUrl/apiKeyEnv（环境变量名），
 * key 由 /connect 写用户级全局配置的 provider apiKey 字段（E27，项目目录不落 .env）或用户自设环境变量。
 */

/** 供应商预设：id 即 provider id，写入 config.providers；apiKeyEnv 是读取 key 的环境变量名（key 本体由 /connect 写用户级配置或用户自设环境变量） */
export interface ProviderPreset {
  id: string;
  name: string;
  /** API 端点 */
  baseUrl: string;
  apiKeyEnv: string;
  /** 协议（缺省 openai-chat-completions）：anthropic 兼容端点的条目须显式标注 */
  protocol?: "openai-chat-completions" | "anthropic-messages";
  models: string[];
  defaultModel: string;
  /** 厂商能力开关默认值（E60，语义见 config schema）：推理厂商 thinking 回传 reasoning_content */
  reasoningContent?: boolean;
  /** 厂商能力开关默认值（E60）：支持 reasoning_effort 请求参数（对 reasoning 模型下发） */
  reasoningEffort?: boolean;
  /** 厂商能力开关默认值（E60）：需显式 enable_thinking 参数才开启思考（对 reasoning 模型发送） */
  enableThinking?: boolean;
  /** 厂商能力开关默认值（E63）：请求流式真实用量（stream_options.include_usage） */
  includeUsage?: boolean;
  /** models 中属于推理系列（支持思考输出）的模型 id：写配置时对应模型标 reasoning: true */
  reasoningModels?: string[];
}

/**
 * 主流模型厂商预设（各厂商 API 端点 + 各自 API Key 环境变量）。
 * 同厂商多种接入方式 = 多条预设、id 不同，名称标清接入方式与协议；anthropic 兼容
 * 端点条目带 protocol: "anthropic-messages"（缺省 openai-chat-completions）。
 * 端点与协议逐一对照厂商官方文档核实（连通性归真机验证）。
 * 模型 id 会随厂商更新而过期（厂商常以下线旧名的方式切换型号），接入报「模型不存在」
 * 时先对照厂商文档核实模型 id，再更新本表（最近核对：2026-08-29）。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    // 支持 reasoning_effort 的厂商（E60）：预设模型 gpt-4o 系非推理系列不带该参数，
    // 用户加推理系列模型（reasoning: true）后思考等级经此参数下发
    reasoningEffort: true,
    includeUsage: true,
    models: ["gpt-4o", "gpt-4o-mini"],
    defaultModel: "gpt-4o",
  },
  {
    id: "deepseek",
    name: "DeepSeek（OpenAI 兼容）",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    // V4 起不再分对话/推理两条线：pro 旗舰（复杂分析与 Agent 任务）、flash 高速双模式；
    // 旧名 deepseek-chat/deepseek-reasoner 已于 2026-07-24 停用
    // 推理厂商（E60）：thinking 必须以 reasoning_content 字段回传，否则工具轮 400
    reasoningContent: true,
    includeUsage: true,
    reasoningModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    defaultModel: "deepseek-v4-pro",
  },
  {
    id: "moonshot",
    name: "Moonshot（Kimi，OpenAI 兼容）",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    includeUsage: true,
    models: ["moonshot-v1-8k", "moonshot-v1-32k"],
    defaultModel: "moonshot-v1-32k",
  },
  {
    // Kimi 官方 Anthropic 兼容端点（platform.kimi.com/docs/guide/claude-code-kimi）
    id: "moonshot-anthropic",
    name: "Moonshot（Kimi，Anthropic 兼容）",
    baseUrl: "https://api.moonshot.cn/anthropic",
    apiKeyEnv: "MOONSHOT_API_KEY",
    protocol: "anthropic-messages",
    models: ["kimi-k3", "kimi-k2.7-code"],
    defaultModel: "kimi-k3",
  },
  {
    id: "qwen",
    name: "通义千问（DashScope）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    // DashScope 需显式 enable_thinking 才开启思考（E60）：随思考等级对 reasoning 模型发送，
    // 不发送则思考等级静默无效
    enableThinking: true,
    includeUsage: true,
    reasoningModels: ["qwen-plus", "qwen-max"],
    models: ["qwen-plus", "qwen-max"],
    defaultModel: "qwen-plus",
  },
  {
    // 计费 API（按 token 计费；编码套餐过期后用资源包也走这个端点）
    id: "zhipu",
    name: "智谱 GLM（计费 API）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnv: "ZHIPU_API_KEY",
    models: ["glm-4-plus", "glm-4-flash"],
    defaultModel: "glm-4-plus",
  },
  {
    // GLM Coding Plan 订阅（Anthropic 兼容端点，docs.bigmodel.cn/cn/guide/develop/claude）
    id: "zhipu-coding",
    name: "智谱 GLM Coding Plan（Anthropic 兼容）",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    apiKeyEnv: "ZHIPU_API_KEY",
    protocol: "anthropic-messages",
    models: ["glm-5.3", "glm-5.3-flash", "glm-5.3-flash[1m]"],
    defaultModel: "glm-5.3",
  },
  {
    id: "google",
    name: "Google Gemini（OpenAI 兼容端点）",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
    models: ["gemini-2.0-flash", "gemini-2.5-pro"],
    defaultModel: "gemini-2.0-flash",
  },
  {
    id: "openrouter",
    name: "OpenRouter（聚合）",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    includeUsage: true,
    models: ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
    defaultModel: "anthropic/claude-sonnet-4-5",
  },
  {
    // opencode 订阅 API：Zen（主端点）与 Go（另一网关）两条路径，key 同为订阅凭据
    id: "opencode-zen",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    // 占位模型：连接时经 /models 端点拉全量替换（fetchProviderModels），此处只保底
    models: ["claude-sonnet-4-5"],
    defaultModel: "claude-sonnet-4-5",
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    models: ["claude-sonnet-4-5"],
    defaultModel: "claude-sonnet-4-5",
  },
];
