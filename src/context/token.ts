import type { Message } from "../core/index.js";

/**
 * 每字符估算 token 数：取保守较大值（宁高估触发压缩，不留爆窗风险）。
 * 英文约 4 字符/token，中文约 1 字符/token，混合取 0.3。
 */
const TOKENS_PER_CHAR = 0.3;

/**
 * 把单条消息近似为请求文本的字符数（统一口径估算上下文体积）。
 * @param message 消息
 * @returns 近似字符数
 */
function messageChars(message: Message): number {
  switch (message.role) {
    case "user":
      return message.content.length;
    case "tool_result":
      return message.content.length;
    case "assistant": {
      let n = 0;
      for (const block of message.content) {
        if (block.type === "text") n += block.text.length;
        else if (block.type === "thinking") n += block.thinking.length;
        else n += block.name.length + JSON.stringify(block.input).length;
      }
      return n;
    }
  }
}

/**
 * 估算消息数组的 token 数：字符数 × 系数，不追求精确、留安全余量。
 * @param messages 消息数组
 * @returns 估算 token 数
 */
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(messages.reduce((sum, message) => sum + messageChars(message), 0) * TOKENS_PER_CHAR);
}

/** 触发判断的窗口参数 */
export interface CompactThresholdOptions {
  /** 模型上下文窗口（token） */
  contextWindow: number;
  /** 保留给模型回复输出的 token */
  maxOutputTokens: number;
  /** 安全余量 token：预留避免撞线 */
  safetyMargin: number;
}

/**
 * 判断是否需要压缩：估算 token 是否超过实际可用窗口。
 * 实际可用窗口 = contextWindow - maxOutputTokens - safetyMargin。
 * @param tokens 当前估算 token 数
 * @param options 窗口参数
 * @returns 是否需要压缩
 */
export function needsCompact(tokens: number, options: CompactThresholdOptions): boolean {
  const available = options.contextWindow - options.maxOutputTokens - options.safetyMargin;
  return tokens >= available;
}
