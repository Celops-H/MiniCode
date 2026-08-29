import type { Message, UserMessage } from "../core/index.js";

/** 文件操作工具：从 input.path 提取最近操作的文件 */
const FILE_TOOLS = new Set(["read", "write", "edit"]);

/** 恢复上下文消息的标记前缀（压缩后由系统注入，source: "system"；增量合并时据此排除在增量之外） */
export const RECOVERY_MARKER = "【恢复上下文】";

/** 恢复上下文里单条用户请求的最大长度（DESIGN 9.4 紧凑补回：防大输入被完整拷回导致连续压缩自我放大） */
const MAX_REQUEST_CHARS = 200;

/** 恢复上下文提取的截断选项 */
export interface RecoveryContextOptions {
  /** 最多记录最近操作文件数，默认 5 */
  maxFiles?: number;
  /** 最多记录最近用户请求数，默认 3 */
  maxRequests?: number;
}

/** 压缩前提取的关键状态，压缩后以紧凑形式补回（DESIGN 9.4） */
export interface RecoveryContext {
  /** 最近操作的文件（按最近使用顺序去重） */
  files: string[];
  /** 活跃任务：最近几条用户请求 */
  recentRequests: string[];
  /** 会话起始上下文：首条用户消息 */
  sessionStart?: string;
}

/**
 * 从消息中提取压缩后需要恢复的关键状态。
 * @param messages 待压缩的对话消息
 * @param options 截断选项
 * @returns 恢复上下文
 */
export function extractRecoveryContext(
  messages: Message[],
  options: RecoveryContextOptions = {},
): RecoveryContext {
  const maxFiles = options.maxFiles ?? 5;
  const maxRequests = options.maxRequests ?? 3;

  // 最近操作文件：逆序扫描工具调用，取最近的去重 path
  const files: string[] = [];
  for (let i = messages.length - 1; i >= 0 && files.length < maxFiles; i--) {
    const message = messages[i]!; // 循环边界保证 i 不越界，断言去掉 undefined
    if (message.role !== "assistant") continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j]!; // 同上，j 不越界
      if (block.type !== "tool_call" || !FILE_TOOLS.has(block.name)) continue;
      const path = (block.input as { path?: unknown }).path;
      if (typeof path === "string" && path.length > 0 && !files.includes(path)) {
        files.push(path);
      }
    }
  }

  // 活跃任务：最近的用户请求（排除摘要/恢复上下文等系统注入消息，避免连续压缩自我放大；
  // 命令痕迹【命令】/init 等不是用户请求，同样排除）。单条截断到 MAX_REQUEST_CHARS，
  // 防大输入被完整带回
  const recentRequests: string[] = [];
  for (let i = messages.length - 1; i >= 0 && recentRequests.length < maxRequests; i--) {
    const message = messages[i]!; // 循环边界保证 i 不越界
    if (message.role === "user" && (message.source ?? "human") === "human") {
      recentRequests.push(truncateRequest(message.content));
    }
  }

  // 会话起始上下文：首条真实用户消息（排除系统注入的摘要）
  const firstUser = messages.find(
    (message): message is UserMessage =>
      message.role === "user" && message.source !== "system",
  );
  const sessionStart = firstUser ? truncateRequest(firstUser.content) : undefined;

  return { files, recentRequests, sessionStart };
}

/** 截断单条用户请求（超出部分省略号标记）；末尾为高代理项时回退一位，避免拆散 emoji 等代理对 */
function truncateRequest(content: string): string {
  if (content.length <= MAX_REQUEST_CHARS) return content;
  let cut = MAX_REQUEST_CHARS;
  const code = content.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return `${content.slice(0, cut)}…`;
}

/**
 * 把恢复上下文生成紧凑文本（仅输出非空部分）。
 * @param context 恢复上下文
 * @returns 恢复文本；无任何关键状态时返回空串
 */
export function buildRecoveryText(context: RecoveryContext): string {
  const sections: string[] = [];
  if (context.files.length > 0) {
    sections.push(`最近操作文件：${context.files.join("、")}`);
  }
  if (context.recentRequests.length > 0) {
    sections.push(`活跃任务：${context.recentRequests.join("；")}`);
  }
  if (context.sessionStart) {
    sections.push(`会话起始：${context.sessionStart}`);
  }
  return sections.join("\n");
}
