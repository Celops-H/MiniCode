import { readFile } from "node:fs/promises";

/**
 * 解析 .env 文本为键值对象（标准 .env 格式的简化实现）：
 * `KEY=VALUE` 行；`#` 开头的注释与空行忽略；支持可选 `export ` 前缀；
 * 值可带单双引号（剥离）；已有环境变量优先（不覆盖）。
 * @param text .env 文件内容
 * @param env 已有环境变量（决定哪些键不覆盖），缺省 process.env
 * @returns 解析出的键值（不含已有变量）
 */
export function parseEnvFile(
  text: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eqIdx = withoutExport.indexOf("=");
    if (eqIdx === -1) continue; // 无 `=` 的行忽略

    const key = withoutExport.slice(0, eqIdx).trim();
    if (key === "") continue;
    if (env[key] !== undefined) continue; // 已有环境变量优先，.env 不覆盖

    let value = withoutExport.slice(eqIdx + 1).trim();
    // 行内注释（E88，标准 dotenv 语义）：未加引号的值剥 " #" 起的注释尾巴——该加载器
    // 主要为 API key 服务，用户按通行习惯写 `KEY=value # prod` 会拿到静默损坏的 key，
    // 401 时难排查；加引号的值不剥（引号内的 # 是内容），引号后跟注释同样生效
    const hashIdx = value.indexOf(" #");
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (hashIdx >= 0 && !quoted) {
      value = value.slice(0, hashIdx).trim();
    }
    result[key] = stripQuotes(value);
  }
  return result;
}

/**
 * 读取并解析 .env 文件为键值对象；文件不存在返回空对象。
 * @param file .env 文件路径
 * @param env 已有环境变量（决定哪些键不覆盖），缺省 process.env
 * @returns 解析出的键值
 */
export async function loadEnvFile(
  file: string,
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  return parseEnvFile(text, env);
}

/** 剥离配对包裹的单双引号 */
function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
