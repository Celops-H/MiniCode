import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { validateInput, outputLimitNote, type ExecuteContext } from "../base.js";
import type { ExecuteResult, Tool } from "../base.js";
import { currentCwd } from "../file-state.js";
import { killProcessTree, startBackgroundTask } from "./bash-background.js";

/** 输出累积上限，与 exec 的 maxBuffer 对齐：超过即丢弃后续输出，防内存膨胀 */
const MAX_BASH_OUTPUT_CHARS = 4 * 1024 * 1024;

/** 排水窗口：进程退出后等管道关闭的宽限时长；到点销毁流强制收尾（窗口内未吐完的尾部输出会丢） */
const DRAIN_WINDOW_MS = 1000;

const MAX_RESULT_CHARS = 30000;

const schema = z.object({
  command: z.string().describe("要执行的 shell 命令"),
  timeoutMs: z.number().int().positive().optional().describe("超时毫秒数，到点终止并标记失败；缺省 30000"),
  background: z.boolean().optional().describe("true 时命令转后台执行，立即返回任务 id，用 bash_task 查询与终止"),
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
  description:
    "在系统 shell 中执行命令，返回标准输出与错误输出。" +
    "默认 30 秒超时，到点终止并返回失败；预计更久的命令传更大的 timeoutMs（毫秒）。" +
    "background 为 true 时命令转后台执行，立即返回任务 id，用 bash_task 查询与终止。" +
    outputLimitNote(MAX_RESULT_CHARS),
  inputSchema: schema,
  isReadOnly: false,
  isConcurrencySafe(input) {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return false;
    // 后台长时进程不进并发批（保守非并发）
    if (parsed.data.background) return false;
    return isReadOnlyBashCommand(parsed.data.command);
  },
  maxResultSizeChars: MAX_RESULT_CHARS,
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
 * 兼容旧 exec 语义：非零退出、超时、中断都标记 isError（命令失败另带失败原因，
 * 由执行器转发 PostToolUseFailure）。
 * 结算条件是「进程退出 + stdio 流全部关闭」：管道被别的进程持有时靠排水窗口兜底，
 * 保证调用必然返回（否则命令早退但管道不关，整个调用长时间无返回）。
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
    // 立即关闭 stdin：工具执行是非交互语义，等待输入的命令（如裸 cat）读到 EOF 即退出，
    // 而不是挂着直到超时被杀
    child.stdin?.on("error", () => {});
    child.stdin?.end();
    let output = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    /** exit 事件已到（与退出码无关：信号杀时 code 为 null，不能拿 exitCode 判退出） */
    let exited = false;
    /** 退出码：仅用于失败文案，信号杀为 null（与旧 close 语义一致，显示「未知」） */
    let exitCode: number | null = null;
    let openStreams = 0;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

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
    const cleanup = (): void => {
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    // 输出解码：stdout/stderr 各用 StringDecoder 按流累积解码——chunk.toString()
    // 按段解码会把恰在 chunk 边界被劈开的多字节字符（中文输出常见）解成 U+FFFD 乱码
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const appendText = (text: string): void => {
      if (output.length >= MAX_BASH_OUTPUT_CHARS) {
        if (!output.endsWith("[输出已截断]")) output += "\n[输出已截断]";
        return;
      }
      output += text;
    };

    const collect = (chunk: Buffer, decoder: StringDecoder): void => {
      appendText(decoder.write(chunk));
    };

    const settle = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const details = output.trim();
      if (aborted) {
        resolve({ output: `${details ? `${details}\n` : ""}(命令已被用户打断)`, isError: true });
        return;
      }
      if (timedOut) {
        resolve({
          output: `${details ? `${details}\n` : ""}（命令执行超时，已终止；长命令可传更大的 timeoutMs 参数重试）`,
          isError: true,
        });
        return;
      }
      if (exitCode !== 0) {
        const reason = `命令失败：退出码 ${exitCode ?? "未知"}`;
        resolve({ output: details ? `${reason}\n${details}` : reason, isError: true, error: reason });
        return;
      }
      resolve(details.length > 0 ? details : "(命令无输出)");
    };
    const maybeSettle = (): void => {
      if (exited && openStreams === 0) settle();
    };

    const streams: Array<[NonNullable<typeof child.stdout>, StringDecoder]> = [
      [child.stdout!, stdoutDecoder],
      [child.stderr!, stderrDecoder],
    ];
    for (const [stream, decoder] of streams) {
      openStreams++;
      stream.on("data", (chunk: Buffer) => collect(chunk, decoder));
      stream.on("close", () => {
        // 流关闭 flush 解码器残料：完整字符不丢、状态不跨流污染；真不完整的尾字节按 U+FFFD 产出
        appendText(decoder.end());
        openStreams--;
        maybeSettle();
      });
      // 超时/打断杀进程后管道可能断裂（EPIPE 等），输出已尽力收集，吞掉防未处理错误崩溃
      stream.on("error", () => {});
    }

    // spawn 本身失败（shell 不可用等罕见路径）也尽快收尾
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(`命令启动失败：${err.message}`);
    });

    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      // 进程退出但管道写端仍被存活进程持有（shell 经 start/& 启动的后台孙进程继承了
      // stdout/stderr 句柄）时，流不会关闭，「close」迟迟不来导致整个调用长时间无返回
      // （若根因是 shell 本身不退出则 exit 不来，仍靠超时/打断救回）：给一个排水窗口
      // 收剩余输出，到点销毁流强制收尾，保证调用必然返回
      drainTimer = setTimeout(() => {
        for (const [stream] of streams) stream.destroy();
        maybeSettle();
      }, DRAIN_WINDOW_MS);
      maybeSettle();
    });
  });
}
