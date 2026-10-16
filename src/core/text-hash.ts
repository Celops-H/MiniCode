/**
 * 短文本指纹（FNV-1a base36，非安全场景）：标识文本版本用。
 * 系统提示词在两处要同一 hash——agent 发 LlmCallEnd 的 systemPrompt.hash，
 * 装配层注入轨迹 header metadata.promptHash；共用本函数即不会算出两种值。
 */
export function hashText(text: string): string {
  let hash = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x1000193);
  }
  return (hash >>> 0).toString(36);
}
