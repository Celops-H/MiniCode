import os from "node:os";

/** 环境变量与平台注入（测试用）：缺省读 process.env 与 process.platform */
export interface EnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * 环境信息段（N3）：OS/架构/Shell/工作目录四项，供模型感知运行环境（CLI/TUI 共用，
 * 经 createSessionAgent 注入系统提示词）。Shell 如实报告实际执行者（E80）：POSIX 取
 * SHELL；Windows 的 bash 工具经 spawn(shell:true) 实际由 cmd.exe 执行（Git Bash 启动
 * 时 SHELL 指向 bash 会诱导模型写 bash 语法命令），取 COMSPEC 报告真实 shell。
 * @param cwd 工作目录；缺省进程 cwd（协作子 agent 传各自实际 cwd，worktree 隔离时是子工作区）
 * @param opts 环境变量与平台注入（测试用）
 * @returns 环境信息提示词段
 */
export function environmentPrompt(cwd: string = process.cwd(), opts: EnvironmentOptions = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const osName = platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : platform;
  const shell =
    platform === "win32"
      ? (env.COMSPEC ?? "cmd.exe")
      : (env.SHELL ?? "未知");
  return `当前环境：操作系统 ${osName}（${os.release()}），架构 ${process.arch}，Shell ${shell}，工作目录 ${cwd}`;
}
