/**
 * 厂商预设（种子模板）：CLI/TUI 同源共享——全局配置播种按这份列表写 providers，
 * /connect 弹窗按这份列表展示。key 不进预设：只写 baseUrl/apiKeyEnv（环境变量名），
 * key 由 /connect 写用户级全局配置的 provider apiKey 字段（项目目录不落 .env）或用户自设环境变量。
 */

/**
 * 预设内单个模型：id + 目录核实过的窗口与输出上限。
 * contextWindow / maxTokens 取自 models.dev 目录（最近核对：2026-10-04），
 * 单位 token；目录未收录且无厂商文档依据的不写字段——运行时按模型目录代查，
 * 仍没有则按 204800 兜底（不把猜测值烙成「手写配置」挡住后续目录纠错），
 * 对应模型在预设列表里注释标注待核。
 */
export interface PresetModel {
  id: string;
  /** 上下文窗口（token） */
  contextWindow?: number;
  /** 厂商单次回复输出上限（token） */
  maxTokens?: number;
}

/** 供应商预设：id 即 provider id，写入 config.providers；apiKeyEnv 是读取 key 的环境变量名（key 本体由 /connect 写用户级配置或用户自设环境变量） */
export interface ProviderPreset {
  id: string;
  name: string;
  /** API 端点 */
  baseUrl: string;
  apiKeyEnv: string;
  /** 协议（缺省 openai-chat-completions）：anthropic 兼容端点的条目须显式标注 */
  protocol?: "openai-chat-completions" | "anthropic-messages";
  /** models.dev 目录的厂商键：预设 id 与目录键不一致时映射（一致的省略） */
  catalogId?: string;
  models: PresetModel[];
  defaultModel: string;
  /** 厂商能力开关默认值：推理厂商 thinking 回传 reasoning_content */
  reasoningContent?: boolean;
  /** 厂商能力开关默认值：支持 reasoning_effort 请求参数（对 reasoning 模型下发） */
  reasoningEffort?: boolean;
  /** 厂商能力开关默认值：需显式 enable_thinking 参数才开启思考（对 reasoning 模型发送） */
  enableThinking?: boolean;
  /** 厂商能力开关默认值：请求流式真实用量（stream_options.include_usage） */
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
    // 支持 reasoning_effort 的厂商：预设模型 gpt-4o 系非推理系列不带该参数，
    // 用户加推理系列模型（reasoning: true）后思考等级经此参数下发
    reasoningEffort: true,
    includeUsage: true,
    models: [
      { id: "gpt-4o", contextWindow: 128_000, maxTokens: 16_384 },
      { id: "gpt-4o-mini", contextWindow: 128_000, maxTokens: 16_384 },
    ],
    defaultModel: "gpt-4o",
  },
  {
    id: "deepseek",
    name: "DeepSeek（OpenAI 兼容）",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    // V4 起不再分对话/推理两条线：pro 旗舰（复杂分析与 Agent 任务）、flash 高速双模式；
    // 旧名 deepseek-chat/deepseek-reasoner 已于 2026-07-24 停用
    // 推理厂商：thinking 必须以 reasoning_content 字段回传，否则工具轮 400
    reasoningContent: true,
    includeUsage: true,
    reasoningModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
    models: [
      { id: "deepseek-v4-pro", contextWindow: 1_000_000, maxTokens: 393_216 },
      { id: "deepseek-v4-flash", contextWindow: 1_000_000, maxTokens: 393_216 },
    ],
    defaultModel: "deepseek-v4-pro",
  },
  {
    id: "moonshot",
    name: "Moonshot（Kimi，OpenAI 兼容）",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    includeUsage: true,
    catalogId: "moonshotai",
    // 窗口按模型名自带档位（v1-8k/v1-32k）；输出上限目录未列，不烙猜测值
    models: [
      { id: "moonshot-v1-8k", contextWindow: 8_192 },
      { id: "moonshot-v1-32k", contextWindow: 32_768 },
    ],
    defaultModel: "moonshot-v1-32k",
  },
  {
    // Kimi 官方 Anthropic 兼容端点（platform.kimi.com/docs/guide/claude-code-kimi）
    id: "moonshot-anthropic",
    name: "Moonshot（Kimi，Anthropic 兼容）",
    baseUrl: "https://api.moonshot.cn/anthropic",
    apiKeyEnv: "MOONSHOT_API_KEY",
    protocol: "anthropic-messages",
    catalogId: "moonshotai",
    // 两模型都支持 thinking 参数（k3 默认开启可关；k2.7-code 强制开启，缺参数请求被拒）
    reasoningModels: ["kimi-k3", "kimi-k2.7-code"],
    models: [
      { id: "kimi-k3", contextWindow: 1_048_576, maxTokens: 1_048_576 },
      { id: "kimi-k2.7-code", contextWindow: 262_144, maxTokens: 262_144 },
    ],
    defaultModel: "kimi-k3",
  },
  {
    id: "qwen",
    name: "通义千问（DashScope）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    // DashScope 需显式 enable_thinking 才开启思考：随思考等级对 reasoning 模型发送，
    // 不发送则思考等级静默无效
    enableThinking: true,
    includeUsage: true,
    catalogId: "alibaba",
    reasoningModels: ["qwen-plus", "qwen-max"],
    models: [
      { id: "qwen-plus", contextWindow: 1_000_000, maxTokens: 32_768 },
      { id: "qwen-max", contextWindow: 32_768, maxTokens: 8_192 },
    ],
    defaultModel: "qwen-plus",
  },
  {
    // 计费 API（按 token 计费；编码套餐过期后用资源包也走这个端点）。
    // 清单按内置目录 zhipuai 条目核对（该条目端点即本端点，最近核对：2026-10-06）：
    // 目录未收录的旧名 glm-4-plus / glm-4-flash 移除（无目录依据，无法核实窗口与输出上限）；
    // 视觉模型（glm-5v-turbo / glm-4.5v / glm-4.6v / glm-4.6v-flash）不收——本项目无图片输入形态
    id: "zhipu",
    name: "智谱 GLM（计费 API）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnv: "ZHIPU_API_KEY",
    catalogId: "zhipuai",
    // glm 系思考增量经 reasoning_content 字段下发（目录 zhipuai 条目标注）：
    // 开启后 assistant 消息带该字段回传，思考块不退化为 <thinking> 文本占上下文
    reasoningContent: true,
    // 全系列均支持思考（目录 reasoning: true 均为真）；连接时经 /models 拉全量替换列表，
    // 拉取条目无能力位信息，reasoning 标记只对预设内模型保留
    reasoningModels: [
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.3-flashx",
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "glm-4.7",
      "glm-4.7-flash",
      "glm-4.7-flashx",
      "glm-4.6",
      "glm-4.5",
      "glm-4.5-air",
      "glm-4.5-flash",
    ],
    models: [
      { id: "glm-5.3", contextWindow: 1_000_000, maxTokens: 131_072 },
      { id: "glm-5.3-flash", contextWindow: 1_000_000, maxTokens: 131_072 },
      { id: "glm-5.3-flashx", contextWindow: 1_000_000, maxTokens: 131_072 },
      { id: "glm-5.2", contextWindow: 1_000_000, maxTokens: 131_072 },
      { id: "glm-5.1", contextWindow: 200_000, maxTokens: 131_072 },
      { id: "glm-5", contextWindow: 204_800, maxTokens: 131_072 },
      { id: "glm-4.7", contextWindow: 204_800, maxTokens: 131_072 },
      { id: "glm-4.7-flash", contextWindow: 200_000, maxTokens: 131_072 },
      { id: "glm-4.7-flashx", contextWindow: 200_000, maxTokens: 131_072 },
      { id: "glm-4.6", contextWindow: 204_800, maxTokens: 131_072 },
      { id: "glm-4.5", contextWindow: 131_072, maxTokens: 98_304 },
      { id: "glm-4.5-air", contextWindow: 131_072, maxTokens: 98_304 },
      { id: "glm-4.5-flash", contextWindow: 131_072, maxTokens: 98_304 },
    ],
    defaultModel: "glm-5.3",
  },
  {
    // GLM Coding Plan 订阅（Anthropic 兼容端点，docs.bigmodel.cn/cn/guide/develop/claude）
    id: "zhipu-coding",
    name: "智谱 GLM Coding Plan（Anthropic 兼容）",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    apiKeyEnv: "ZHIPU_API_KEY",
    protocol: "anthropic-messages",
    catalogId: "zhipuai-coding-plan",
    // GLM-5.3 系列均支持思考（端点按 Claude Code 语义接 thinking 参数与 effort 映射）
    reasoningModels: ["glm-5.3", "glm-5.3-flash", "glm-5.3-flash[1m]"],
    models: [
      { id: "glm-5.3", contextWindow: 1_000_000, maxTokens: 131_072 },
      { id: "glm-5.3-flash", contextWindow: 1_000_000, maxTokens: 131_072 },
      // 待核：目录未单列该条目，窗口与输出上限按同端点 glm-5.3-flash 同值处理
      { id: "glm-5.3-flash[1m]", contextWindow: 1_000_000, maxTokens: 131_072 },
    ],
    defaultModel: "glm-5.3",
  },
  {
    id: "google",
    name: "Google Gemini（OpenAI 兼容端点）",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
    // 待核：gemini-2.0-flash 未收录进模型目录，窗口与输出上限按兜底处理
    models: [
      { id: "gemini-2.0-flash" },
      { id: "gemini-2.5-pro", contextWindow: 1_048_576, maxTokens: 65_536 },
    ],
    defaultModel: "gemini-2.0-flash",
  },
  {
    id: "openrouter",
    name: "OpenRouter（聚合）",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    includeUsage: true,
    models: [
      // 待核：目录侧 id 为 anthropic/claude-sonnet-4.5（点号写法），值按同模型取
      { id: "anthropic/claude-sonnet-4-5", contextWindow: 1_000_000, maxTokens: 64_000 },
      { id: "openai/gpt-4o", contextWindow: 128_000, maxTokens: 16_384 },
    ],
    defaultModel: "anthropic/claude-sonnet-4-5",
  },
  {
    // opencode 订阅 API：Zen（主端点）与 Go（另一网关）两条路径，key 同为订阅凭据
    id: "opencode-zen",
    name: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    catalogId: "opencode",
    // 占位模型：连接时经 /models 端点拉全量替换（fetchProviderModels），此处只保底
    models: [{ id: "claude-sonnet-4-5", contextWindow: 1_000_000, maxTokens: 64_000 }],
    defaultModel: "claude-sonnet-4-5",
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    // 占位模型：连接时经 /models 端点拉全量替换（fetchProviderModels），此处只保底；
    // 待核：Go 端点未单独收录，窗口与输出上限按同凭据 Zen 端点同模型取
    models: [{ id: "claude-sonnet-4-5", contextWindow: 1_000_000, maxTokens: 64_000 }],
    defaultModel: "claude-sonnet-4-5",
  },
];
