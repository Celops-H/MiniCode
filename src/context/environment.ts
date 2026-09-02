import os from "node:os";

/**
 * 环境信息段（N3）：OS/架构/Shell/工作目录四项，供模型感知运行环境（CLI/TUI 共用，
 * 经 createSessionAgent 注入系统提示词）。Shell 从环境变量取，Windows 缺省记 PowerShell。
 * @param cwd 工作目录；缺省进程 cwd（协作子 agent 传各自实际 cwd，worktree 隔离时是子工作区）
 * @returns 环境信息提示词段
 */
export function environmentPrompt(cwd: string = process.cwd()): string {
  const osName = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : process.platform;
  const shell = process.env.SHELL ?? (process.platform === "win32" ? "PowerShell" : "未知");
  return `当前环境：操作系统 ${osName}（${os.release()}），架构 ${process.arch}，Shell ${shell}，工作目录 ${cwd}`;
}
