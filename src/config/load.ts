import { readFile } from "node:fs/promises";
import { configSchema, type Config } from "./types.js";
import { resolveConfigPaths, type ConfigPaths } from "./paths.js";

export interface LoadConfigOptions {
  /** 配置文件路径（测试可注入） */
  paths?: ConfigPaths;
  /** 环境变量（测试可注入） */
  env?: NodeJS.ProcessEnv;
}

/**
 * 加载配置：默认值 < 全局配置 < 项目配置 < 环境变量，逐级覆盖合并。
 * 校验失败（非法字段 / 格式错误）直接抛出。
 * @param opts 加载选项（paths / env 可注入，测试用）
 * @returns 合并并校验后的配置
 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<Config> {
  const paths = opts.paths ?? resolveConfigPaths();
  const env = opts.env ?? process.env;

  const defaults = configSchema.parse({});
  const globalRaw = await readJsonFile(paths.globalConfigFile);
  const projectRaw = await readJsonFile(paths.projectConfigFile);
  const envRaw = pickEnvConfig(env);

  return configSchema.parse({
    ...defaults,
    ...globalRaw,
    ...projectRaw,
    ...envRaw,
  });
}

/**
 * 读取并解析 JSON 文件。
 * @param file 文件路径
 * @returns 解析出的对象；文件不存在返回 null，解析失败或非对象抛出
 */
async function readJsonFile(file: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    // 文件不存在视为没有该级配置源
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const data: unknown = JSON.parse(text);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`配置文件格式错误（应为 JSON 对象）：${file}`);
  }
  return data as Record<string, unknown>;
}

/**
 * 从环境变量提取 MINICODE_* 配置项，下划线转驼峰。
 * @param env 环境变量对象
 * @returns 驼峰键 → 值的映射
 */
function pickEnvConfig(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("MINICODE_") && value !== undefined) {
      const name = key
        .slice("MINICODE_".length)
        .toLowerCase()
        .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      result[name] = value;
    }
  }
  return result;
}
