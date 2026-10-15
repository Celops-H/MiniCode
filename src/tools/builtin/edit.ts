import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { validateInput } from "../base.js";
import type { Tool } from "../base.js";
import { currentFileState, resolvePath } from "../file-state.js";

const schema = z.object({
  path: z.string().describe("目标文件路径"),
  oldString: z.string().describe("待替换的旧文本，须在文件中唯一匹配"),
  newString: z.string().describe("替换后的新文本"),
});

/** 成功回灌时改动块上下各取的行数：够模型确认落点，又不撑上下文 */
const SNIPPET_CONTEXT_LINES = 3;

/**
 * 取改动块及上下文的带行号片段：行号从 1 起，行号与内容用制表符分隔（与 read 同口径）。
 * @param content 改动后的文件内容
 * @param firstLine 改动块首行行号（1 起）
 * @param lineCount 改动块行数
 * @returns 带行号的片段文本
 */
function snippetAround(content: string, firstLine: number, lineCount: number): string {
  const lines = content.split("\n");
  const start = Math.max(1, firstLine - SNIPPET_CONTEXT_LINES);
  const end = Math.min(lines.length, firstLine + lineCount - 1 + SNIPPET_CONTEXT_LINES);
  return lines
    .slice(start - 1, end)
    .map((line, i) => `${start + i}\t${line}`)
    .join("\n");
}

/** 精确替换文件中的一段文本；旧文本不唯一或不存在时抛错 */
export const editTool: Tool = {
  name: "edit",
  description: "在文件中精确替换一段文本，旧文本须唯一匹配",
  inputSchema: schema,
  isReadOnly: false,
  maxResultSizeChars: 1000,
  async execute(input) {
    const { path, oldString, newString } = validateInput<{
      path: string;
      oldString: string;
      newString: string;
    }>(editTool, input);
    const file = resolvePath(path); // 相对路径基于工具执行上下文 cwd
    const fileState = currentFileState();
    const edit = async () => {
      // CAS 校验：磁盘 vs 本 agent 快照，冲突拒绝
      const stale = fileState ? await fileState.assertWritable(file) : null;
      if (stale) return stale;

      const content = await readFile(file, "utf8");
      const firstIndex = content.indexOf(oldString);
      if (firstIndex === -1) {
        throw new Error(`未找到待替换的文本：${path}`);
      }
      const count = content.split(oldString).length - 1;
      if (count > 1) {
        throw new Error(`待替换文本出现 ${count} 次，须唯一匹配：${path}`);
      }

      const updated = content.slice(0, firstIndex) + newString + content.slice(firstIndex + oldString.length);
      await writeFile(file, updated, "utf8");
      await fileState?.refreshVersion(file, updated);
      // 回灌改动位置与上下片段：模型据此确认落点，不必重读整文件
      const firstLine = content.slice(0, firstIndex).split("\n").length;
      const lineCount = newString.split("\n").length;
      return `已替换 1 处（第 ${firstLine} 行）\n${snippetAround(updated, firstLine, lineCount)}`;
    };
    // per-path 锁关 TOCTOU：校验 + 读 + 替换 + 写入 + 刷新快照一气呵成
    return fileState ? fileState.withFileLock(file, edit) : edit();
  },
};
