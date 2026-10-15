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
    // 行内注释：通行 shell/python-dotenv 语义——未加引号的值剥 " #" 起的注释
    // 尾巴，纯注释值（# 打头）为空串；该加载器主要为 API key 服务，用户按通行习惯写
    // `KEY=value # prod` 会拿到静默损坏的 key，401 时难排查。
    // 引号判定按「首字符引号找配对闭引号」（按末字符判会让两类输入损坏——
    // 引号值内含 # 且后跟注释 `"a # b" # tail` 会在引号内截断得 `"a`；注释以引号结尾
    // `"a" # "b"` 误判整段为引号值不剥注释）。配对闭引号之后到行尾的内容视为注释剥掉，
    // 引号内的 # 是内容不剥；引号未配对或无引号按未加引号值处理（无空格的 `v#x`
    // 保留，密码含 # 更安全）
    const quote = value[0];
    const closeIdx = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1;
    const tail = closeIdx > 0 ? value.slice(closeIdx + 1).trim() : "";
    if (closeIdx > 0 && (tail === "" || tail.startsWith("#"))) {
      value = value.slice(0, closeIdx + 1);
    } else if (value.startsWith("#")) {
      value = "";
    } else {
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
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

/** 本进程由 applyEnvFile 注入过的键，按目标环境对象记录：
 *  重读时这些键按文件当前内容刷新；目标对象里原有的键（进程外导出的变量）始终不动 */
const injectedKeys = new WeakMap<object, Set<string>>();

/**
 * 读取 .env 文件并把变量注入目标环境对象；文件不存在则不做改动。
 * 目标对象里原有的变量保持原值（进程外导出的优先，启动与重读一致）；
 * 本函数此前注入过的键按文件当前内容刷新，手改 .env 后重读即生效。
 * @param file .env 文件路径
 * @param target 目标环境对象（缺省 process.env）
 */
export async function applyEnvFile(
  file: string,
  target: Record<string, string | undefined> = process.env,
): Promise<void> {
  // 以空环境为基准解析取文件全部键：解析层会按已有环境过滤键，该不该写由这里判定
  const vars = await loadEnvFile(file, {});
  const injected = injectedKeys.get(target) ?? new Set<string>();
  injectedKeys.set(target, injected);
  for (const [key, value] of Object.entries(vars)) {
    if (injected.has(key) || target[key] === undefined) {
      target[key] = value;
      injected.add(key);
    }
  }
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
