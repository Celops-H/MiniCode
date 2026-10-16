import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { normalizeCommandWord, stripCommandPrefix, uniqWritesToFile } from "../../core/index.js";
import { resolveCommandShell, type CommandShellKind } from "../../permission/dangerous.js";
import { validateInput, outputLimitNote, type ExecuteContext } from "../base.js";
import type { ExecuteResult, Tool } from "../base.js";
import { currentCwd } from "../file-state.js";
import { killProcessTree, startBackgroundTask } from "./bash-background.js";

/** 输出累积上限，与 exec 的 maxBuffer 对齐：每条流超过即丢弃后续输出，防内存膨胀 */
const MAX_BASH_OUTPUT_CHARS = 4 * 1024 * 1024;

/** 排水窗口：进程退出后等管道关闭的宽限时长；到点销毁流强制收尾（窗口内未吐完的尾部输出会丢） */
const DRAIN_WINDOW_MS = 1000;

const MAX_RESULT_CHARS = 30000;

/** 失败回灌里 stderr 摘要的字符上限：只取尾部，错误信息通常在末尾 */
const MAX_STDERR_SUMMARY_CHARS = 2000;

/** 失败类型：决定失败回灌末尾的可重试标记 */
type FailureKind = "timeout" | "exit" | "spawn";

/**
 * 可重试标记：告诉模型重跑同一命令是否有意义，避免失败后盲目重试或直接停摆。
 * 超时与启动失败重跑有意义（换更大的 timeoutMs、瞬态故障），非零退出是命令本身的问题，
 * 同一命令重跑结果不变，须先修正命令。
 */
const RETRY_MARKER: Record<FailureKind, string> = {
  timeout: "[可重试] 加大 timeoutMs 或缩小命令范围后重跑",
  exit: "[不可重试] 同一命令重跑结果不变，请先修正命令",
  spawn: "[可重试] 可能是瞬态失败，可重跑一次",
};

/** shell 语义的显示名：描述与失败回灌共用，模型据 shell 名判断该写哪种语法 */
const SHELL_LABEL: Record<CommandShellKind, string> = {
  bash: "bash",
  cmd: "cmd.exe",
  powershell: "PowerShell",
};

/**
 * bash 工具描述里的平台与语法提示：写明命令由哪个 shell 执行、哪些语法可用。
 * Windows 下 spawn(shell:true) 走 COMSPEC，Git Bash 里 SHELL 指向 bash 会诱导模型写
 * Unix 风格命令，实际由 cmd.exe 执行，命令当场失败。描述先讲执行方与替代方案，
 * 模型才不会派 ls/cat/grep 一类命令。
 * @param kind shell 语义；缺省读当前平台与环境
 * @returns 提示文案
 */
export function bashShellNote(kind: CommandShellKind = resolveCommandShell()): string {
  if (kind === "cmd") {
    return `当前平台 Windows，命令由 ${SHELL_LABEL.cmd} 执行。管道 |、重定向 >、&& 可用；$() 替换与单引号不生效。` +
      "ls/cat/grep/rm 等 Unix 命令不保证可用，列目录用 dir、看文件用 type，搜索与读文件用内置 grep、read。";
  }
  if (kind === "powershell") {
    return `当前平台 Windows，命令由 ${SHELL_LABEL.powershell} 执行。用 PowerShell 语法：Get-ChildItem、Get-Content、Select-String。` +
      "ls/cat/rm 等 Unix 名是内置别名可用，grep 改用 Select-String 或内置 grep。";
  }
  return "命令由 POSIX shell 执行，Unix 命令、管道、重定向、$() 替换与单引号均可用。";
}

const schema = z.object({
  command: z.string().describe("要执行的 shell 命令"),
  timeoutMs: z.number().int().positive().optional().describe("超时毫秒数，到点终止并标记失败；缺省 30000"),
  background: z.boolean().optional().describe("true 时命令转后台执行，立即返回任务 id，用 bash_task 查询与终止"),
});

/**
 * 只读命令白名单：这些命令本身不修改系统状态，可并发执行。
 * 常见写命令（rm/mv/cp/mkdir/touch/git commit 等）不在其中，保持保守。
 * 包装命令（sudo/env/timeout 等）不入表：剥开按真实命令词判定。
 */
const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "grep", "find", "wc", "pwd", "echo",
  "printf", "file", "stat", "du", "df", "sort", "uniq", "cut", "tr",
  "history", "date", "which", "whereis", "type", "realpath",
  "dirname", "basename", "tree", "diff", "comm", "cmp",
]);

/**
 * 白名单内命令的写选项：命中即写文件或改系统状态，判非只读。
 * sort/tree/file 的输出旗标落盘（只读守卫的 sort/date/history/tree/file 分支同口径），
 * date 的 -s/--set 设系统时间，history 的 -w/-a 写历史文件。短选项取值可与旗标同词（sort -oout.txt、date -s2020-01-01），
 * 按前缀匹配。只收旗标形态：uniq 的第二操作数落盘见 uniqWritesToFile，
 * 包装命令由 stripCommandPrefix 剥开按真实命令词判。
 */
const WRITE_OPTION_RE: Record<string, RegExp> = {
  // cmd 的 /o 与 POSIX 的 -o/--output：输出写入文件；/o 按整词匹配，
  // 不误伤以 /o 开头的路径操作数（如 /opt/f.txt）；命令名不分大小写，/O 一并认
  sort: /^\/o$|^-[A-Za-z]*o|^--output(=|$)/i,
  // -s/--set 设系统时间；-d/-r/-I 等显示形态不写（-Iseconds 这类带值旗标不误判）
  date: /^-s|^--set(=|$)/,
  // -o/--output 输出写入文件
  tree: /^-[A-Za-z]*o|^--output(=|$)/,
  // -C/--compile 编译魔数库落盘（小写 -c 是检查打印，不误判）
  file: /^-[A-Za-z]*C|^--compile(=|$)/,
  // -w 写、-a 追加历史文件；-r/-n 读、-c 清内存不写
  history: /^-[A-Za-z]*[wa]$/,
};

/**
 * 判断 bash 命令是否只读安全（可并发执行）。
 * 只认简单命令 + 命令名在白名单；出现重定向、管道、连接符、后台、
 * 子 shell、命令替换、变量赋值前缀等任何可能修改状态的结构，一律非只读（保守）。
 * 段首包装命令（sudo/env/timeout 等）剥开后按真实命令词判定（env rm x 判非只读）。
 * 白名单内的命令带写选项（sort -o、date -s 等）或 uniq 的第二操作数落盘，同样判非只读。
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
  // 剥开段首包装与分组符号，按真实命令词判定；command -v/-V 只查询路径、不执行命令，判非只读（保守）
  const { rest, queried } = stripCommandPrefix(trimmed.split(/\s+/));
  if (queried || rest.length === 0) return false;
  const first = normalizeCommandWord(rest[0]!);
  const args = rest.slice(1);
  // find 的写操作（delete/exec/execdir/okdir/ok/print 到文件等）→ 改变状态
  if (
    first === "find" &&
    /-(delete|exec|execdir|okdir|ok|fprint|fprintf|fprint0|fls)\b/.test(trimmed)
  ) {
    return false;
  }
  if (!READ_ONLY_COMMANDS.has(first)) return false;
  // 白名单命令带写选项 → 写文件或改系统状态
  const writeOption = WRITE_OPTION_RE[first];
  if (writeOption && args.some((word) => writeOption.test(word))) return false;
  // uniq 的第二操作数落盘 → 写文件
  if (first === "uniq" && uniqWritesToFile(args)) return false;
  return true;
}

/** 执行 shell 命令，返回标准输出与错误输出；非零退出或超时返回错误信息 */
export const bashTool: Tool = {
  name: "bash",
  description:
    "在系统 shell 中执行命令，返回标准输出与错误输出。" +
    bashShellNote() +
    "命令非交互执行，标准输入已关闭。" +
    "不要运行等待输入或确认的交互式命令，这类命令会读到 EOF 或挂到超时。" +
    "默认 30 秒超时，到点终止并返回失败；预计更久的命令传更大的 timeoutMs（毫秒），长时命令改用 background。" +
    "失败结果带错误输出摘要与可重试标记，按标记判断是重跑还是先修正命令。" +
    "同一命令连续失败 3 次后不再执行，须换命令或换做法。" +
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
  truncationNote: "结果不完整，建议缩小命令范围或改用内置 grep 搜索",
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
 * 失败回灌文本：失败原因 + stderr 节 + 可重试标记 + stdout。
 * stderr 单独成节，避免与 stdout 混在一起看不清错误来源；过长只取尾部并标注。
 * 诊断信息（原因、stderr、标记）排在 stdout 之前：执行器按上限截断时留的是头部，
 * 大 stdout 的失败命令若把标记排在尾部，恰在该出现时被截掉。
 * @param reason 失败原因行（与结构化结果的 error 同源）
 * @param stdoutText 标准输出（已去首尾空白）
 * @param stderrText 标准错误（已去首尾空白）
 * @param kind 失败类型，决定可重试标记
 * @returns 回灌模型的失败文本
 */
function failureOutput(reason: string, stdoutText: string, stderrText: string, kind: FailureKind): string {
  const lines = [reason];
  if (stderrText.length > 0) lines.push(`[stderr]\n${stderrSummary(stderrText)}`);
  lines.push(RETRY_MARKER[kind]);
  if (stdoutText.length > 0) lines.push(stdoutText);
  return lines.join("\n");
}

/** stderr 摘要：不超上限原样返回，超出只留尾部并标注（错误信息通常在末尾） */
function stderrSummary(text: string): string {
  if (text.length <= MAX_STDERR_SUMMARY_CHARS) return text;
  return `（仅末尾 ${MAX_STDERR_SUMMARY_CHARS} 字符）\n${text.slice(-MAX_STDERR_SUMMARY_CHARS)}`;
}

/**
 * 前台执行命令：spawn 起 shell，分别累积 stdout/stderr，维护 cwd 与工具上下文一致。
 * 超时或外部信号（turn 内打断）时跨平台杀子进程树（Windows taskkill /T /F）。
 * 兼容旧 exec 语义：非零退出、超时、启动失败、中断都标记 isError。
 * 超时、非零退出、启动失败另带失败原因，由执行器转发 PostToolUseFailure；
 * 成功结果返回 stdout 与 stderr 分节的正文（stderr 带 [stderr] 节标签），失败结果按
 * 「原因、stderr 节、可重试标记、stdout」排列，诊断信息在前，供模型判断改道还是重跑。
 * 用户打断只标 isError 不带原因（主动行为不算失败）。
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
    let stdout = "";
    let stderr = "";
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
    const appendText = (which: "stdout" | "stderr", text: string): void => {
      const current = which === "stdout" ? stdout : stderr;
      const next =
        current.length >= MAX_BASH_OUTPUT_CHARS
          ? current.endsWith("[输出已截断]")
            ? current
            : `${current}\n[输出已截断]`
          : current + text;
      if (which === "stdout") stdout = next;
      else stderr = next;
    };

    /**
     * 成功或打断的回灌正文：stdout、stderr 各去首尾空白，非空才拼。
     * stderr 单独成节并加 [stderr] 标签（与失败回灌同口径），模型据此分清哪段来自 stderr；
     * 无内容返回空串
     */
    const body = (): string => {
      const parts: string[] = [];
      const stdoutText = stdout.trim();
      if (stdoutText.length > 0) parts.push(stdoutText);
      const stderrText = stderr.trim();
      if (stderrText.length > 0) parts.push(`[stderr]\n${stderrText}`);
      return parts.join("\n");
    };

    const settle = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const text = body();
      if (aborted) {
        resolve({ output: `${text ? `${text}\n` : ""}(命令已被用户打断)`, isError: true });
        return;
      }
      if (timedOut) {
        const reason = `命令执行超时：${timeoutMs}ms 未退出`;
        resolve({
          output: failureOutput(reason, stdout.trim(), stderr.trim(), "timeout"),
          isError: true,
          error: reason,
        });
        return;
      }
      if (exitCode !== 0) {
        const reason = `命令失败：退出码 ${exitCode ?? "未知"}`;
        resolve({
          output: failureOutput(reason, stdout.trim(), stderr.trim(), "exit"),
          isError: true,
          error: reason,
        });
        return;
      }
      resolve(text.length > 0 ? text : "(命令无输出)");
    };
    const maybeSettle = (): void => {
      if (exited && openStreams === 0) settle();
    };

    const streams: Array<[NonNullable<typeof child.stdout>, StringDecoder, "stdout" | "stderr"]> = [
      [child.stdout!, stdoutDecoder, "stdout"],
      [child.stderr!, stderrDecoder, "stderr"],
    ];
    for (const [stream, decoder, which] of streams) {
      openStreams++;
      stream.on("data", (chunk: Buffer) => appendText(which, decoder.write(chunk)));
      stream.on("close", () => {
        // 流关闭 flush 解码器残料：完整字符不丢、状态不跨流污染；真不完整的尾字节按 U+FFFD 产出
        appendText(which, decoder.end());
        openStreams--;
        maybeSettle();
      });
      // 超时/打断杀进程后管道可能断裂（EPIPE 等），输出已尽力收集，吞掉防未处理错误崩溃
      stream.on("error", () => {});
    }

    // spawn 本身失败（shell 不可用等罕见路径）也尽快收尾：与命令失败同口径，
    // 置 isError 并带原因，执行器据此补发 PostToolUseFailure
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      const reason = `命令启动失败：${err.message}`;
      resolve({ output: failureOutput(reason, "", "", "spawn"), isError: true, error: reason });
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
