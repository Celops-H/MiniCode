import { z } from "zod";
import type { Tool } from "../base.js";

/** 子代理系统提示词：独立上下文，只回结论（DESIGN 10.1） */
export const SUBAGENT_SYSTEM_PROMPT =
  "你是子代理，负责独立完成主代理交给的子任务。你有独立的对话上下文，看不到主代理的完整历史。完成任务后用简洁文字说明结论。";

export interface SubagentDeps {
  /** 执行子代理并返回结论文本 */
  runSubagent: (prompt: string) => Promise<string>;
}

/** 子代理工具：把子任务交给独立上下文的子代理执行，只回传结论（DESIGN 10） */
export function createSubagentTool(deps: SubagentDeps): Tool {
  return {
    name: "subagent",
    description:
      "把子任务交给一个独立的子代理执行：子代理有独立上下文、看不到完整历史，执行完成后只返回结论文本",
    inputSchema: z.object({ prompt: z.string() }),
    isReadOnly: false,
    requiresUserInteraction: false,
    maxResultSizeChars: 1000,
    execute: (input) => deps.runSubagent((input as { prompt: string }).prompt),
  };
}