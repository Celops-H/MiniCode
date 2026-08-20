/**
 * 工具输出截断：超过上限时截断并标记，避免大输出撑爆上下文。
 * 超限时优先在换行边界截断（不切断一行），无合适换行则按精确上限截断。
 */

export interface TruncateResult {
  /** 截断后的内容 */
  content: string;
  /** 是否发生了截断 */
  truncated: boolean;
  /** 原始字符数 */
  originalLength: number;
}

/**
 * 截断内容到上限字符数；未超限或未设上限时原样返回。
 * @param content 原始内容
 * @param maxChars 上限字符数；undefined 或非有限数视为不截断
 * @returns 截断结果（内容、是否截断、原始长度）
 */
export function truncateOutput(content: string, maxChars?: number): TruncateResult {
  const length = content.length;
  if (maxChars === undefined || !Number.isFinite(maxChars) || length <= maxChars) {
    return { content, truncated: false, originalLength: length };
  }
  // 上限内最后一个换行：若位于限内后半段，用换行位避免切断一行，否则精确截断
  const lastNewline = content.lastIndexOf("\n", maxChars);
  const cutPoint = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;
  return { content: content.slice(0, cutPoint), truncated: true, originalLength: length };
}
