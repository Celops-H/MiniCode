/**
 * 工具输出超限落盘（DESIGN 9.1 ①）：大工具输出超限先完整写盘到输出目录，
 * 消息里留截断预览与文件路径，模型需要时用 Read 读回完整内容（无损）；
 * 落盘失败（磁盘满 / 无权限）退化为按上限截断，不阻塞工具执行。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { truncateOutput } from "./truncate.js";

export interface SpillResult {
  /** 回灌模型的文本：截断预览 + 落盘提示；落盘失败时为截断标记 */
  content: string;
  /** 是否发生了截断 */
  truncated: boolean;
  /** 原始字符数 */
  originalLength: number;
  /** 完整内容落盘路径；未超限或落盘失败时无 */
  outputPath?: string;
}

/**
 * 输出超限落盘：未超限原样返回；超限时完整内容写盘，回灌预览与路径。
 * @param content 工具原始输出
 * @param maxChars 结果字符上限；undefined 或非有限数视为不截断
 * @param outputDir 落盘目录（不存在时创建）
 * @returns 落盘结果（回灌文本、是否截断、原始长度、落盘路径）
 */
export function spillOutput(
  content: string,
  maxChars: number | undefined,
  outputDir: string,
): SpillResult {
  const truncated = truncateOutput(content, maxChars);
  if (!truncated.truncated) {
    return { content: truncated.content, truncated: false, originalLength: truncated.originalLength };
  }
  try {
    const file = path.join(outputDir, `tool-${Date.now()}-${randomUUID().slice(0, 8)}.txt`);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(file, content, "utf8");
    return {
      content:
        `${truncated.content}\n` +
        `[输出已截断：共 ${truncated.originalLength} 字符，完整内容已保存到 ${file}，可用 Read 工具读取该文件查看完整输出]`,
      truncated: true,
      originalLength: truncated.originalLength,
      outputPath: file,
    };
  } catch {
    return {
      content:
        `${truncated.content}\n` +
        `[输出已截断：共 ${truncated.originalLength} 字符，保留前 ${truncated.content.length} 字符]`,
      truncated: true,
      originalLength: truncated.originalLength,
    };
  }
}