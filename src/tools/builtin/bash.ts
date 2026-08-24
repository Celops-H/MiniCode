import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { validateInput } from "../base.js";
import type { Tool } from "../base.js";
import { currentCwd } from "../file-state.js";
import { startBackgroundTask } from "./bash-background.js";

const execAsync = promisify(exec);

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
 * 判断 execAsync 抛出的错误是否为超时：Node 在 timeout 后杀进程并置 killed 与 signal。
 * @param err execAsync 抛出的错误
 * @returns 是否超时
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
  async execute(input) {
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
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        cwd: currentCwd(), // 工具执行上下文 cwd（Worktree 场景子 agent 在自己的工作区执行）
      });
      const parts = [stdout.trim(), stderr.trim()].filter(Boolean);
      return parts.length > 0 ? parts.join("\n") : "(命令无输出)";
    } catch (err) {
      const e = err as { message?: string; stdout?: string; stderr?: string };
      const details = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
      const output = `命令失败：${e.message ?? String(err)}${details ? `\n${details}` : ""}`;
      // 超时标记失败，供模型感知；普通命令失败仍以文本返回让模型调整
      if (isExecTimeoutError(err)) {
        return { output: `${output}\n（命令执行超时，已终止）`, isError: true };
      }
      return output;
    }
  },
};
