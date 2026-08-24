import { spawn } from "node:child_process";
import { z } from "zod";
import { validateInput, type ExecuteContext } from "../base.js";
import type { ExecuteResult, Tool } from "../base.js";
import { currentCwd } from "../file-state.js";
import { killProcessTree, startBackgroundTask } from "./bash-background.js";

/** 输出累积上限，与 exec 的 maxBuffer 对齐：超过即丢弃后续输出，防内存膨胀 */
const MAX_BASH_OUTPUT_CHARS = 4 * 1024 * 1024;

const schema = z.object({
  command: z.string(),
  /** 超时毫秒数，默认 30 秒 */
  timeoutMs: z.number().int().positive().optional(),
  /** 后台执行：立即返回任务 id，命令放后台跑，用 bash_task 工具查询与终止（DESIGN 7.5） */
  background: z.boolean().optional(),
});

/**
 * 只读命令白名单：这些命令本身不修改系统状态，可并发执行。
 * 常见写命令（rm/mv/cp/mkdir/touch/git commit 等）不在其中，保持保守。
 */
const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "grep", "find", "wc", "pwd", "echo",
  "printf", "file", "stat", "du", "df", "sort", "uniq", "cut", "tr",
  "history", "date", "env", "which", "whereis", "type", "realpath",
  "dirname", "basename", "tree", "diff", "comm", "cmp",
]);

/**
 * 判断命令是否因超时/中止被强杀：Node 杀进程后错误对象置 killed 与 signal。
 * @param err 命令执行错误
 * @returns 是否被强杀（超时或中断）
 */
export function isExecTimeoutError(err: unknown): boolean {
  const e = err as { killed?: boolean; signal?: string };
  return e?.killed === true && e.signal !== undefined;
}

/**
 * 判断 bash 命令是否只读安全（可并发执行）。
 * 只认简单命令 + 命令名在白名单；出现重定向、管道、连接符、后台、
 * 子 shell、命令替换、变量赋值前缀等任何可能修改状态的结构，一律非只读（保守）。
 * @param command 命令原文
 * @returns 是否只读安全
 */
export function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  // 换行：多行命令（如 echo hi\nrm file）第二行可写，一律非只读
  if (/\r?\n/.test(trimmed)) return false;
  // 重定向、管道、连接符、后台、子 shell → 可能写入文件或改变状态
  if (/[<>|;&()]/.test(trimmed)) return false;
  // 命令替换（$() / 反引号）、变量赋值前缀（VAR=x cmd）→ 改变状态
  if (/\$\(|\x60|^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) return false;
  const first = trimmed.split(/\s+/)[0];
  if (!first) return false;
  // find 的写操作（delete/exec/execdir/okdir/ok/print 到文件等）→ 改变状态
  if (
    first === "find" &&
    /-(delete|exec|execdir|okdir|ok|fprint|fprintf|fprint0|fls)\b/.test(trimmed)
  ) {
    return false;
  }
  return READ_ONLY_COMMANDS.has(first);
}

/** 执行 shell 命令，返回标准输出与错误输出；非零退出或超时返回错误信息 */
export const bashTool: Tool = {
  name: "bash",
  description: "在系统 shell 中执行命令，返回标准输出与错误输出",
  inputSchema: schema,
  isReadOnly: false,
  isConcurrencySafe(input) {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return false;
    // 后台长时进程不进并发批（保守非并发）
    if (parsed.data.background) return false;
    return isReadOnlyBashCommand(parsed.data.command);
  },
  requiresUserInteraction: false,
  maxResultSizeChars: 30000,
  async execute(input, options?: ExecuteContext) {
    const { command, timeoutMs = 30000, background } = validateInput<{
      command: string;
      timeoutMs?: number;
      background?: boolean;
    }>(bashTool, input);
    // 后台执行：立即返回任务 id，命令放后台跑，不阻塞回合
    if (background) {
      const task = startBackgroundTask(command);
      return `已后台启动（任务 ${task.id}）：${command}\n用 bash_task 工具查询状态或终止`;
    }
    return runCommand(command, timeoutMs, options?.signal);
  },
};

/**
 * 前台执行命令：spawn 起 shell，累积 stdout/stderr，维护 cwd 与工具上下文一致。
 * 超时或外部信号（turn 内打断）时跨平台杀子进程树（Windows taskkill /T /F）。
 * 兼容旧 exec 语义：非零退出码返回失败文本、超时/中断标记 isError。
 * @param command shell 命令
 * @param timeoutMs 超时毫秒数
 * @param signal 外部中止信号（用户打断当前轮时透传）
 * @returns 命令输出文本或带失败标记的结构化结果
 */
function runCommand(command: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecuteResult> {
  return new Promise((resolve) => {
    // detached 让 shell 自成进程组（Unix）：killProcessTree 按负 pid 杀整棵进程树；
    // Windows 的 detached 会断开 stdio，且其 taskkill /T 本身按树杀，故只在 Unix 开启（与 bash-background 一致）
    const child = spawn(command, {
      shell: true,
      cwd: currentCwd(),
      detached: process.platform !== "win32",
    });
    let output = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const kill = (): void => {
      if (child.pid) killProcessTree(child.pid);
    };
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // 已中止的信号（interrupt 落在 spawn 前微任务窗口）：立即强杀，不等监听事件
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const collect = (chunk: Buffer): void => {
      if (output.length >= MAX_BASH_OUTPUT_CHARS) {
        if (!output.endsWith("[输出已截断]")) output += "\n[输出已截断]";
        return;
      }
      output += chunk.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    // spawn 本身失败（shell 不可用等罕见路径）也尽快收尾
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(`命令启动失败：${err.message}`);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const details = output.trim();
      if (aborted) {
        resolve({ output: `${details ? `${details}\n` : ""}(命令已被用户打断)`, isError: true });
        return;
      }
      if (timedOut) {
        resolve({ output: `${details ? `${details}\n` : ""}（命令执行超时，已终止）`, isError: true });
        return;
      }
      if (code !== 0) {
        resolve(`命令失败：退出码 ${code ?? "未知"}${details ? `\n${details}` : ""}`);
        return;
      }
      resolve(details.length > 0 ? details : "(命令无输出)");
    });
  });
}
