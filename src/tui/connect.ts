/**
 * /connect 供应商预设与连接写配置。
 * 交互：/connect → 供应商弹窗选择 → 弹窗内输 API Key（Enter 确认）→ 写全局 config + 项目 .env → 重建会话。
 * 写配置逻辑：
 * - 全局 ~/.minicode/config.json：追加/按 id 替换目标 provider（不写 modelChain，模型切换归 /model 命令），过 strict schema
 * - 项目 .env：追加/替换 `${apiKeyEnv}=<key>`（幂等，重复连接更新值不重复追加）
 * 失败不抛进程：返回 { ok, error } 由 loop 展示 toast，进程保留。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { configSchema, type Config } from "../config/types.js";
import { resolveConfigPaths } from "../config/paths.js";

/** 供应商预设：id 即 provider id，写入 config.providers；apiKeyEnv 即写入 .env 的环境变量名 */
export interface ProviderPreset {
  id: string;
  name: string;
  /** OpenAI 兼容 API 端点（必填：后端模型客户端只走 openai-chat-completions 协议） */
  baseUrl: string;
  apiKeyEnv: string;
  models: string[];
  defaultModel: string;
}

/**
 * 主流模型厂商预设（OpenAI 兼容 baseUrl + 各自 API Key 环境变量）。
 * 注：后端模型客户端当前只支持 openai-chat-completions 协议（anthropic 等原生协议 Provider 未实现），
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

/** 读取全局 config 原始对象；文件不存在返回 {} */
async function readGlobalConfigRaw(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    return raw;
  } catch {
    return {};
  }
}

/** 写入全局 config：合并 provider（按 id 追加/替换，不写 modelChain——模型切换归 /model 命令）+ strict 校验 */
export async function writeGlobalConfig(file: string, preset: ProviderPreset): Promise<void> {
  const raw = await readGlobalConfigRaw(file);
  const providers: Config["providers"] = (raw.providers as unknown as Config["providers"]) ?? [];
  const kept = (providers ?? []).filter((p) => p.id !== preset.id);
  const updated: Config["providers"] = [
    ...kept,
    {
      id: preset.id,
      baseUrl: preset.baseUrl,
      apiKeyEnv: preset.apiKeyEnv,
      models: preset.models.map((id) => ({ id })),
    },
  ];
  // 只追加/替换 provider，不动 modelChain：连接供应商只是让它的模型进入列表，当前模型保持、
  // 切换仍由 /model 命令负责（用户定论：连接后保持当前会话、不切换模型）
  const merged = {
    ...raw,
    providers: updated,
  };
  const validated = configSchema.parse(merged);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(validated, null, 2) + "\n", "utf8");
}

/** 追加/替换项目 .env 的 `${key}=<value>` 行（幂等：已有则替换，无则追加） */
export async function writeEnvKey(envFile: string, key: string, value: string): Promise<void> {
  let lines: string[] = [];
  try {
    lines = (await fs.readFile(envFile, "utf8")).split("\n");
  } catch {
    // 无 .env 则新建
  }
  const line = `${key}=${value}`;
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  await fs.writeFile(envFile, lines.join("\n").replace(/\n$/, "") + "\n", "utf8");
}

/** /models 拉取超时（ms）：厂商慢响应时不让连接卡住 */
export const FETCH_MODELS_TIMEOUT_MS = 10_000;

/**
 * 用 API Key 调厂商 /models 端点拉全量模型列表（OpenAI 兼容格式 { data: [{id}] }）。
 * 连接供应商时调用：写入 config 的 models 用真实列表而非手维护的预设占位，
 * 厂商上新模型即时可用（N1）。失败（key 无效/网络不通/非 JSON）抛错由调用方兜底。
 * @param baseUrl 厂商 OpenAI 兼容端点
 * @param apiKey 用户输入的 API Key
 * @param timeoutMs 超时 ms（缺省 FETCH_MODELS_TIMEOUT_MS）
 * @returns 模型 id 列表
 */
export async function fetchProviderModels(baseUrl: string, apiKey: string, timeoutMs = FETCH_MODELS_TIMEOUT_MS): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
}

/** 连接供应商：写全局 config + 项目 .env；成功返回 { ok:true, fetchedModels? }，失败 { ok:false, error }。paths 可注入（测试）。 */
export async function connectProvider(
  preset: ProviderPreset,
  apiKey: string,
  opts: { globalConfigFile?: string; envFile?: string; fetchImpl?: typeof fetchProviderModels } = {},
): Promise<{ ok: boolean; error?: string; fetchedModels?: number }> {
  const trimmed = apiKey.trim();
  if (!trimmed) return { ok: false, error: "API Key 不能为空" };
  try {
    const paths = resolveConfigPaths();
    const globalFile = opts.globalConfigFile ?? paths.globalConfigFile;
    const envFile = opts.envFile ?? path.join(process.cwd(), ".env");
    // 先拉全量模型（10s 超时）：拉到即用真实列表写配置；key 无效/网络失败仅回落预设占位，
    // 不阻断连接——连接的目的（写 key 进配置）不受影响（N1）
    let models = preset.models;
    let fetchedModels: number | undefined;
    try {
      const fetched = await (opts.fetchImpl ?? fetchProviderModels)(preset.baseUrl, trimmed);
      if (fetched.length > 0) {
        models = fetched;
        fetchedModels = fetched.length;
      }
    } catch {
      // 拉取失败用预设占位，静默（不 toast 干扰：连接本身成功）
    }
    await writeGlobalConfig(globalFile, { ...preset, models });
    await writeEnvKey(envFile, preset.apiKeyEnv, trimmed);
    return { ok: true, fetchedModels };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `写配置失败：${msg}` };
  }
}
