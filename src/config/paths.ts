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
 * 解析会话存储目录：默认用户级 `~/.minicode/sessions/`（与全局配置同目录族），
 * 不随启动目录变化（DESIGN 14）；config 可覆盖（见 config.sessionsDir）。
 * @param opts 路径选项（homedir / xdgConfigHome 可注入，测试用）
 * @returns 会话存储目录
 */
export function resolveSessionsDir(opts: ResolvePathsOptions = {}): string {
  const home = opts.homedir ?? os.homedir();
  const xdg = opts.xdgConfigHome;
  const globalDir = xdg ? path.join(xdg, "minicode") : path.join(home, ".minicode");
  return path.join(globalDir, "sessions");
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
