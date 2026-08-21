import type { Message, ToolResultMessage } from "../core/index.js";

/** 已裁剪工具输出的占位标记 */
export const PRUNED_MARKER = "[工具输出已裁剪]";

/**
 * 历史裁剪：把最旧的工具输出替换为裁剪标记，保留最近若干条完整输出。
 * 只替换内容不删消息，保持工具回合结构完整（assistant tool_call 与 tool_result 配对不破坏），
 * 模型仍能读到回合骨架，只是旧结果详情不再占用上下文。
 * @param messages 消息数组
 * @param keepRecent 保留最近的工具结果条数
 * @returns 裁剪后的新数组（原数组不变）
 */
export function pruneToolResults(messages: Message[], keepRecent: number): Message[] {
  const resultIndices = messages
    .map((message, index) => (message.role === "tool_result" ? index : -1))
    .filter((index) => index >= 0);
  const pruneCount = Math.max(0, resultIndices.length - keepRecent);
  if (pruneCount === 0) return messages;

  const copy = [...messages];
  // resultIndices 由构造保证指向 tool_result 消息，断言类型后直接替换内容
  for (const index of resultIndices.slice(0, pruneCount)) {
    const message = copy[index]! as ToolResultMessage;
    copy[index] = { ...message, content: PRUNED_MARKER, isError: false };
  }
  return copy;
}
