import type { ProviderAuth } from "./types.js";

export interface ResolveAuthOptions {
  /** 存放 API key 的环境变量名 */
  apiKeyEnv: string;
  env?: NodeJS.ProcessEnv;
}

export interface ResolveAuthResult {
  auth: ProviderAuth;
  apiKey?: string;
}

/** 认证解析：环境变量（后续扩展：存储凭据 → OAuth） */
export function resolveAuth(options: ResolveAuthOptions): ResolveAuthResult {
  const env = options.env ?? process.env;
  const apiKey = env[options.apiKeyEnv];
  if (apiKey) {
    return { auth: { configured: true, source: "env" }, apiKey };
  }
  return { auth: { configured: false } };
}
