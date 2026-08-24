import { spawn } from "node:child_process";
import { killProcessTree } from "../tools/index.js";
import type { HookEvent, HookHandler, HookVerdict } from "./types.js";

/** 命令 hook 选项 */
export interface CommandHookOptions {
  /** 命令超时 ms，默认 60000；超时视为失败 */
  timeoutMs?: number;
}

/**
 * 命令 hook 适配器（DESIGN 13：外部程序经 Hook 扩展 Agent 的 CLI 形态）：
 * 把一条外部命令包装成 Hook 处理器——事件负载以 JSON 写入命令 stdin，
 * stdout 解析裁决（PreToolUse 才需要，其他事件仅观测）。
 * 协议（精简自 claude-code）：
 * - stdin：`{"hookEvent": {type, ...事件负载}, "cwd": "..."}`（一次写入后关闭）
 * - stdout：`{"verdict": "allow" | "deny" | "ask"}`（仅 PreToolUse 解析）
 * 失败语义（保守）：命令异常退出 / 超时 / stdout 解析失败 → PreToolUse 判 deny，
 * 其余事件忽略；命令 stderr 原样转发到本进程 stderr 作观测输出。
 * @param command 要执行的命令（shell 执行，可含参数）
 * @param options 选项
 * @returns 包装后的 Hook 处理器
 */
export function createCommandHook(command: string, options: CommandHookOptions = {}): HookHandler<HookEvent> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return async (event) => {
    const result = await runCommand(command, event, timeoutMs);
    if (event.type !== "PreToolUse") return undefined; // 观测事件：执行即完成
    if (!result.ok) return "deny"; // 命令失败/超时/解析失败：保守拒绝
    return result.verdict;
  };
}

/** 命令执行结果（内部） */
interface CommandResult {
  ok: boolean;
  verdict: HookVerdict;
}

/** 执行命令：写事件 JSON 到 stdin，读 stdout 解析裁决 */
function runCommand(command: string, event: HookEvent, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    // Unix 用 detached 独立成进程组，便于超时按进程树终止（对齐后台任务的清理方式）
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    let input: string;
    try {
      input = JSON.stringify({ hookEvent: event, cwd: process.cwd() });
    } catch {
      resolve({ ok: false, verdict: "deny" }); // 事件负载不可序列化：按失败处理
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child.pid!); // 按树杀，防止 shell 已死而实际命令残留
      resolve({ ok: false, verdict: "deny" });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, verdict: "deny" });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stderr) {
        // 命令 stderr 作观测输出转发，不影响裁决
        process.stderr.write(`[hook] ${command}: ${stderr.trim()}\n`);
      }
      if (code !== 0) {
        resolve({ ok: false, verdict: "deny" });
        return;
      }
      if (event.type !== "PreToolUse") {
        resolve({ ok: true, verdict: "allow" });
        return;
      }
      resolve({ ok: true, verdict: parseVerdict(stdout) });
    });

    child.stdin.on("error", () => {
      // 命令提前关闭 stdin（EPIPE）：丢弃写入失败，由 close 路径裁决
    });
    child.stdin.write(input, () => {
      child.stdin.end();
    });
  });
}

/** 从 stdout 解析 PreToolUse 裁决；解析失败返回 deny（保守） */
function parseVerdict(stdout: string): HookVerdict {
  try {
    const parsed = JSON.parse(stdout.trim()) as { verdict?: HookVerdict };
    if (parsed.verdict === "allow" || parsed.verdict === "deny" || parsed.verdict === "ask") {
      return parsed.verdict;
    }
  } catch {
    // 非 JSON 输出：按失败处理
  }
  return "deny";
}