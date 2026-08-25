/**
 * /connect 供应商预设与连接写配置（TUI 新任务 3）。
 * 交互：/connect → 供应商弹窗选择 → 输入区输 API Key（Enter 确认）→ 写全局 config + 项目 .env → 重建会话。
 * 写配置逻辑：
 * - 全局 ~/.minicode/config.json：追加/按 id 替换目标 provider、modelChain 以默认模型打头、过 strict schema
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
  baseUrl?: string;
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

/** 写入全局 config：合并 provider（按 id 追加/替换）+ modelChain 默认模型打头 + strict 校验 */
export async function writeGlobalConfig(file: string, preset: ProviderPreset): Promise<void> {
  const raw = await readGlobalConfigRaw(file);
  const providers: Config["providers"] = (raw.providers as unknown as Config["providers"]) ?? [];
  const kept = (providers ?? []).filter((p) => p.id !== preset.id);
  const updated: Config["providers"] = [
    ...kept,
    {
      id: preset.id,
      baseUrl: preset.baseUrl ?? "https://api.openai.com/v1",
      apiKeyEnv: preset.apiKeyEnv,
      models: preset.models.map((id) => ({ id })),
    },
  ];
  const modelChain = [preset.defaultModel, ...((raw.modelChain as string[] | undefined) ?? []).filter((m) => m !== preset.defaultModel)];
  const merged = {
    ...raw,
    providers: updated,
    modelChain,
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

/** 连接供应商：写全局 config + 项目 .env；成功返回 { ok:true }，失败 { ok:false, error }。paths 可注入（测试）。 */
export async function connectProvider(
  preset: ProviderPreset,
  apiKey: string,
  opts: { globalConfigFile?: string; envFile?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = apiKey.trim();
  if (!trimmed) return { ok: false, error: "API Key 不能为空" };
  try {
    const paths = resolveConfigPaths();
    const globalFile = opts.globalConfigFile ?? paths.globalConfigFile;
    const envFile = opts.envFile ?? path.join(process.cwd(), ".env");
    await writeGlobalConfig(globalFile, preset);
    await writeEnvKey(envFile, preset.apiKeyEnv, trimmed);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `写配置失败：${msg}` };
  }
}