/**
 * /connect 供应商预设与连接写配置。
 * 交互：/connect → 供应商弹窗选择 → 弹窗内输 API Key（Enter 确认）→ 写全局 config → 重建会话。
 * 写配置逻辑：
 * - 全局 ~/.minicode/config.json：追加/按 id 替换目标 provider，key 写进该 provider 的
 *   apiKey 字段（E27：用户级配置落 key，项目目录不落 .env），不写 modelChain（模型切换
 *   归 /model 命令），过 strict schema
 * 失败不抛进程：返回 { ok, error } 由 loop 展示 toast，进程保留。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { configSchema, type Config } from "../config/types.js";
import { resolveConfigPaths } from "../config/paths.js";
import { PROVIDER_PRESETS, type ProviderPreset } from "../config/presets.js";

export { PROVIDER_PRESETS };
export type { ProviderPreset };

/** 读取全局 config 原始对象；文件不存在返回 {} */
async function readGlobalConfigRaw(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    return raw;
  } catch {
    return {};
  }
}

/**
 * 写入全局 config：合并 provider（按 id 追加/替换，不写 modelChain——模型切换归 /model 命令）+ strict 校验。
 * @param file 全局配置文件路径
 * @param preset 供应商预设
 * @param apiKey 落盘 API key（写进 provider 的 apiKey 字段；可省略仅更新端点/模型）
 */
export async function writeGlobalConfig(file: string, preset: ProviderPreset, apiKey?: string): Promise<void> {
  const raw = await readGlobalConfigRaw(file);
  const providers: Config["providers"] = (raw.providers as unknown as Config["providers"]) ?? [];
  const kept = (providers ?? []).filter((p) => p.id !== preset.id);
  const updated: Config["providers"] = [
    ...kept,
    {
      id: preset.id,
      baseUrl: preset.baseUrl,
      apiKeyEnv: preset.apiKeyEnv,
      ...(apiKey ? { apiKey } : {}),
      ...(preset.protocol ? { protocol: preset.protocol } : {}),
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
  // POSIX 权限同 seed.ts：目录 700 / 配置 600（apiKey 落盘在此，不应对其他用户可读）；
  // mode 仅创建时生效——存量 644 配置（老版本建出）写回前显式收紧（批次 5~8 审查建议）
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(validated, null, 2) + "\n", { mode: 0o600, encoding: "utf8" });
  await fs.chmod(file, 0o600);
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

/** 连接供应商：key 写全局 config 的 provider apiKey 字段（项目目录不落 .env）；成功返回 { ok:true, fetchedModels? }，失败 { ok:false, error }。paths 可注入（测试）。 */
export async function connectProvider(
  preset: ProviderPreset,
  apiKey: string,
  opts: { globalConfigFile?: string; fetchImpl?: typeof fetchProviderModels } = {},
): Promise<{ ok: boolean; error?: string; fetchedModels?: number }> {
  const trimmed = apiKey.trim();
  if (!trimmed) return { ok: false, error: "API Key 不能为空" };
  try {
    const globalFile = opts.globalConfigFile ?? resolveConfigPaths().globalConfigFile;
    // 先拉全量模型（10s 超时）：拉到即用真实列表写配置；key 无效/网络失败仅回落预设占位，
    // 不阻断连接——连接的目的（写 key 进配置）不受影响（N1）。
    // anthropic 协议端点无 OpenAI /models 拉取约定（Bearer + {data:[{id}]}），直接用
    // 预设占位，不空耗一次注定失败的请求
    let models = preset.models;
    let fetchedModels: number | undefined;
    if (preset.protocol !== "anthropic-messages") {
      try {
        const fetched = await (opts.fetchImpl ?? fetchProviderModels)(preset.baseUrl, trimmed);
        if (fetched.length > 0) {
          models = fetched;
          fetchedModels = fetched.length;
        }
      } catch {
        // 拉取失败用预设占位，静默（不 toast 干扰：连接本身成功）
      }
    }
    await writeGlobalConfig(globalFile, { ...preset, models }, trimmed);
    return { ok: true, fetchedModels };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `写配置失败：${msg}` };
  }
}
