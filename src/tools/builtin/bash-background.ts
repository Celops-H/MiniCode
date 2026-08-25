import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { currentCwd } from "../file-state.js";

/** 后台任务状态：运行中 / 完成 / 失败 / 已终止 */
export type BackgroundTaskStatus = "running" | "completed" | "failed" | "killed";

export interface BackgroundTask {
  id: string;
  command: string;
  status: BackgroundTaskStatus;
  /** 退出码：completed 为 0，failed 为非 0 或未定义 */
  exitCode?: number;
  /** 累积输出（stdout + stderr），超上限截断 */
  output: string;
  /** 进程启动错误（如 spawn 失败） */
  error?: string;
  startedAt: number;
}

/** 输出累积上限，与前台 bash 的 maxBuffer 对齐 */
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

interface TaskEntry {
  task: BackgroundTask;
  /** 子进程引用：任务结束（close）后置空释放，防注册表长期持有已结束进程句柄 */
  child: ChildProcess | null;
}

/** 模块级后台任务注册表（DESIGN 7.5）：任务随进程存活，宿主进程退出时统一清理 */
const tasks = new Map<string, TaskEntry>();
let nextId = 1;

/**
 * 启动一个后台命令：spawn detached 子进程，stdout/stderr 累积到任务输出。
 * 立即返回任务对象（状态 running），模型据此轮询 `bash_task` 工具。
 * @param command shell 命令
 * @returns 后台任务
 */
export function startBackgroundTask(command: string): BackgroundTask {
  const task: BackgroundTask = {
    id: `b${nextId++}`,
    command,
    status: "running",
    output: "",
    startedAt: Date.now(),
  };
  // Unix 用 detached 让子进程独立成进程组，便于按进程树终止；
  // Windows 的 detached 会断开 stdio 导致收不到输出，改用 taskkill /T 按树杀
  const child = spawn(command, {
    shell: true,
    detached: process.platform !== "win32",
    cwd: currentCwd(), // 绑定工具执行上下文 cwd（后台命令与前台一致，Worktree 隔离不绕过）
  });
  child.stdout?.on("data", (chunk: Buffer) => appendOutput(task, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendOutput(task, chunk));
  child.on("error", (err) => {
    task.status = "failed";
    task.error = err.message;
  });
  child.on("close", (code) => {
    // killed 已由 killBackgroundTask 标记，这里不再覆盖
    if (task.status === "running") {
      task.status = code === 0 ? "completed" : "failed";
      task.exitCode = code ?? undefined;
    }
    // 任务结束释放子进程句柄：任务对象（含最终输出）保留供查询，防注册表无限持已结束进程
    const entry = tasks.get(task.id);
    if (entry) entry.child = null;
  });
  tasks.set(task.id, { task, child });
  return task;
}

/** 按 id 取后台任务；不存在返回 undefined */
export function getBackgroundTask(id: string): BackgroundTask | undefined {
  return tasks.get(id)?.task;
}

/**
 * 终止后台任务：按进程树强杀（Unix kill 进程组，Windows taskkill /T）。
 * 不存在的任务返回 undefined。
 * @param id 任务 id
 * @returns 终止后的任务对象
 */
export function killBackgroundTask(id: string): BackgroundTask | undefined {
  const entry = tasks.get(id);
  if (!entry) return undefined;
  entry.task.status = "killed";
  const pid = entry.child?.pid;
  if (pid !== undefined) killProcessTree(pid);
  return entry.task;
}

/**
 * 终止所有后台任务（宿主进程退出时调用，防孤儿进程）。返回终止数量。
 */
export function killAllBackgroundTasks(): number {
  let count = 0;
  for (const entry of tasks.values()) {
    if (entry.task.status === "running") {
      entry.task.status = "killed";
      const pid = entry.child?.pid;
      if (pid !== undefined) killProcessTree(pid);
      count++;
    }
  }
  return count;
}

function appendOutput(task: BackgroundTask, chunk: Buffer) {
  if (task.output.length >= MAX_OUTPUT_CHARS) {
    if (!task.output.endsWith("[输出已截断]")) task.output += "\n[输出已截断]";
    return;
  }
  task.output += chunk.toString();
}

/** 跨平台按进程树强杀：Unix 杀新进程组（负 pid），Windows 用 taskkill /T */
export function killProcessTree(pid: number) {
  if (process.platform === "win32") {
    // 同步执行：确保返回时进程已被杀掉，避免调用方（如测试清理）提前退出导致漏杀
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 进程已退出
      }
    }
  }
}