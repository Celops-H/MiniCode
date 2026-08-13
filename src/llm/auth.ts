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

/**
 * 认证解析：从环境变量读取 API key。
 * @param options 认证解析选项（含环境变量名；env 可注入，测试用）
 * @returns 解析结果：auth 状态（configured / source）+ 若已配置则带 apiKey
 */
export function resolveAuth(options: ResolveAuthOptions): ResolveAuthResult {
  const env = options.env ?? process.env;
  const apiKey = env[options.apiKeyEnv];
  if (apiKey) {
    return { auth: { configured: true, source: "env" }, apiKey };
  }
  return { auth: { configured: false } };
}
