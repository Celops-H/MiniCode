/**
 * 厂商预设（种子模板）：CLI/TUI 同源共享——全局配置播种按这份列表写 providers，
 * /connect 弹窗按这份列表展示。key 不进预设：只写 baseUrl/apiKeyEnv（环境变量名），
 * key 由 /connect 写项目 .env 或用户自设环境变量。
 */

/** 供应商预设：id 即 provider id，写入 config.providers；apiKeyEnv 即写入 .env 的环境变量名 */
export interface ProviderPreset {
  id: string;
  name: string;
  /** OpenAI 兼容 API 端点 */
  baseUrl: string;
  apiKeyEnv: string;
  models: string[];
  defaultModel: string;
}

/**
 * 主流模型厂商预设（OpenAI 兼容 baseUrl + 各自 API Key 环境变量）。
 * 注：后端模型客户端当前只走 openai-chat-completions 协议，
 * 故只列 OpenAI 兼容接口可用的厂商；Gemini 走其官方 OpenAI 兼容端点。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    models: ["gpt-4o", "gpt-4o-mini"],
    defaultModel: "gpt-4o",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
  },
  {
    id: "moonshot",
    name: "Moonshot（Kimi）",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    models: ["moonshot-v1-8k", "moonshot-v1-32k"],
    defaultModel: "moonshot-v1-32k",
  },
  {
    id: "qwen",
    name: "通义千问（DashScope）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    models: ["qwen-plus", "qwen-max"],
    defaultModel: "qwen-plus",
  },
  {
    id: "zhipu",
    name: "智谱清言（GLM）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnv: "ZHIPU_API_KEY",
    models: ["glm-4-plus", "glm-4-flash"],
    defaultModel: "glm-4-plus",
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
