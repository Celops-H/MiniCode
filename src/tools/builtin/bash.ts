import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { validateInput } from "../base.js";
import type { Tool } from "../base.js";

const execAsync = promisify(exec);

const schema = z.object({
  command: z.string(),
  /** 超时毫秒数，默认 30 秒 */
  timeoutMs: z.number().int().positive().optional(),
});

/** 执行 shell 命令，返回标准输出与错误输出；非零退出或超时返回错误信息 */
export const bashTool: Tool = {
  name: "bash",
  description: "在系统 shell 中执行命令，返回标准输出与错误输出",
  inputSchema: schema,
  isReadOnly: false,
  requiresUserInteraction: false,
  maxResultSizeChars: 30000,
  async execute(input) {
    const { command, timeoutMs = 30000 } = validateInput<{
      command: string;
      timeoutMs?: number;
    }>(bashTool, input);
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      const parts = [stdout.trim(), stderr.trim()].filter(Boolean);
      return parts.length > 0 ? parts.join("\n") : "(命令无输出)";
    } catch (err) {
      const e = err as { message?: string; stdout?: string; stderr?: string };
      const details = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
      return `命令失败：${e.message ?? String(err)}${details ? `\n${details}` : ""}`;
    }
  },
};
