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
