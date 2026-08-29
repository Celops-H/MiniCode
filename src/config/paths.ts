import os from "node:os";
import path from "node:path";

export interface ConfigPaths {
  /** 全局配置文件（用户级） */
  globalConfigFile: string;
  /** 项目配置文件（当前工作区） */
  projectConfigFile: string;
}

export interface ResolvePathsOptions {
  homedir?: string;
  cwd?: string;
  /** XDG_CONFIG_HOME，提供时优先于 homedir */
  xdgConfigHome?: string;
}

/**
 * 解析全局与项目配置文件路径。
 * @param opts 路径选项（homedir / cwd / xdgConfigHome 可注入，测试用）
 * @returns 全局与项目配置文件路径
 */
export function resolveConfigPaths(opts: ResolvePathsOptions = {}): ConfigPaths {
  const home = opts.homedir ?? os.homedir();
  const xdg = opts.xdgConfigHome;
  const globalDir = xdg ? path.join(xdg, "minicode") : path.join(home, ".minicode");
  const cwd = opts.cwd ?? process.cwd();
  return {
    globalConfigFile: path.join(globalDir, "config.json"),
    projectConfigFile: path.join(cwd, ".minicode.json"),
  };
}

/**
 * 解析会话存储目录：按启动工作目录分子目录（E46，DESIGN 14）——
 * `<root>/<sanitizePath(cwd)>`，各工作目录只看自己的会话。root 缺省用户级
 * `~/.minicode/sessions/`（config.sessionsDir 可覆盖，语义为根目录）。
 * @param opts 路径选项（homedir / xdgConfigHome / root / cwd 可注入，测试用）
 * @returns 会话存储目录
 */
export function resolveSessionsDir(
  opts: ResolvePathsOptions & { root?: string } = {},
): string {
  const home = opts.homedir ?? os.homedir();
  const xdg = opts.xdgConfigHome;
  const globalDir = xdg ? path.join(xdg, "minicode") : path.join(home, ".minicode");
  const root = opts.root ?? path.join(globalDir, "sessions");
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  return path.join(root, sanitizePath(cwd));
}

/** 会话子目录名长度上限：超长截断并追加内容哈希后缀（防截断后撞名） */
const MAX_SANITIZED_LENGTH = 200;

/**
 * 启动目录 → 会话子目录名：非字母数字字符一律替换为「-」（跨平台安全——Windows
 * 盘符冒号与路径分隔符一并替换）；超长截断并追加原串哈希后缀防撞名。
 * @param name 待编码的路径
 * @returns 编码后的子目录名
 */
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${fnv1aBase36(name)}`;
}

/** FNV-1a 哈希的 base36 形式（撞名防御用短哈希，非安全场景） */
function fnv1aBase36(text: string): string {
  let hash = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x1000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * 解析工具输出落盘目录：默认用户级 `~/.minicode/outputs/`（与全局配置同目录族），
 * 大工具输出超限时完整内容写到这里，消息里留路径供 Read 读回（DESIGN 9.1 ①）。
 * @param opts 路径选项（homedir / xdgConfigHome 可注入，测试用）
 * @returns 输出落盘目录
 */
export function resolveOutputsDir(opts: ResolvePathsOptions = {}): string {
  const home = opts.homedir ?? os.homedir();
  const xdg = opts.xdgConfigHome;
  const globalDir = xdg ? path.join(xdg, "minicode") : path.join(home, ".minicode");
  return path.join(globalDir, "outputs");
}
