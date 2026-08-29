import type { ProviderAuth } from "./types.js";

export interface ResolveAuthOptions {
  /** 存放 API key 的环境变量名 */
  apiKeyEnv: string;
  /** 配置里落盘的 API key（E33：与环境变量同权；环境变量优先——显式注入的临时 key 覆盖落盘值） */
  storedKey?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ResolveAuthResult {
  auth: ProviderAuth;
  apiKey?: string;
}

/**
 * 认证解析：环境变量与落盘 key 同权，任一存在即已配置（E33）。
 * 优先级：环境变量 > 落盘 key；auth.source 标明实际生效来源。
 * @param options 认证解析选项（含环境变量名与可选落盘 key；env 可注入，测试用）
 * @returns 解析结果：auth 状态（configured / source）+ 若已配置则带 apiKey
 */
export function resolveAuth(options: ResolveAuthOptions): ResolveAuthResult {
  const env = options.env ?? process.env;
  const envKey = env[options.apiKeyEnv];
  if (envKey) {
    return { auth: { configured: true, source: "env" }, apiKey: envKey };
  }
  if (options.storedKey) {
    return { auth: { configured: true, source: "stored" }, apiKey: options.storedKey };
  }
  return { auth: { configured: false } };
}
