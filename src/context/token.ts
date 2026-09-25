import type { Message } from "../core/index.js";

/**
 * token 估算系数（E79 改分段计价）：中文（CJK）分词器实测约 1 字符 1 token，
 * 英文/数字/符号约 4 字符 1 token（记 0.25）。此前的单一系数 0.3 注释称「保守较大值
 * 宁高估」，实际对中文系统性低估约 3 倍——本项目提示词/指令/用户输入以中文为主，
 * 压缩触发点系统性滞后、频繁落到应急剥组。分段计价后中文占比越高估算越大，不再依赖
 * 「混合场景恰好凑对」。
 */
const CJK_TOKENS_PER_CHAR = 1;
/** 英文/数字/符号/空白每字符 token：略高于 1/4 取整前的真实值，留一点余量 */
const OTHER_TOKENS_PER_CHAR = 0.25;

/** CJK 字符判定（常用范围近似）：汉字（含扩展 A/B）、日文假名、韩文谚文音节 */
function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0x20000 && code <= 0x2a6df)
  );
}

/**
 * 按字符分类计价估算 token 数：CJK 每字符记 1，其余每字符记 0.25。
 * @param text 文本
 * @returns 估算 token 数（未取整）
 */
function textTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (isCjk(code)) cjk++;
    else other++;
  }
  return cjk * CJK_TOKENS_PER_CHAR + other * OTHER_TOKENS_PER_CHAR;
}

/**
 * 把单条消息近似为请求文本并估算 token（统一口径估算上下文体积）。
 * @param message 消息
 * @returns 估算 token 数（未取整）
 */
function messageTokens(message: Message): number {
  switch (message.role) {
    case "user":
      return textTokens(message.content);
    case "tool_result":
      return textTokens(message.content);
    case "assistant": {
      let n = 0;
      for (const block of message.content) {
        if (block.type === "text") n += textTokens(block.text);
        else if (block.type === "thinking") n += textTokens(block.thinking);
        else n += textTokens(block.name + JSON.stringify(block.input));
      }
      return n;
    }
  }
}

/**
 * 估算消息数组的 token 数：按 CJK/其他分段计价，不追求精确、留安全余量。
 * @param messages 消息数组
 * @returns 估算 token 数
 */
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(messages.reduce((sum, message) => sum + messageTokens(message), 0));
}

/**
 * 估算一段文本的 token 数（与消息同口径：CJK/其他分段计价）。
 * 系统提示词不占消息位，压缩触发判断按同口径单独计入（E15）。
 * @param text 文本
 * @returns 估算 token 数
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(textTokens(text));
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
