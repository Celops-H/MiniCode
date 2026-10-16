import { glob } from "node:fs/promises";
import { z } from "zod";
import { validateInput, outputLimitNote } from "../base.js";
import type { Tool } from "../base.js";
import { currentCwd, resolvePath } from "../file-state.js";

const MAX_RESULT_CHARS = 10000;

const schema = z.object({
  pattern: z.string().describe("glob 模式，如 **/*.ts"),
  path: z.string().optional().describe("搜索起始目录，缺省当前工作目录"),
});

/** 按 glob 模式查找文件，返回匹配路径列表 */
export const globTool: Tool = {
  name: "glob",
  description:
    "按 glob 模式查找文件，返回匹配路径列表。" +
    "结果不保证排序；按内容搜索用 grep 工具，读文件内容用 read 工具。" +
    outputLimitNote(MAX_RESULT_CHARS),
  inputSchema: schema,
  isReadOnly: true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: MAX_RESULT_CHARS,
  truncationNote: "结果不完整，建议缩小搜索范围或用更精确的模式",
  async execute(input) {
    const { pattern, path: cwd } = validateInput<{ pattern: string; path?: string }>(globTool, input);
    const matches: string[] = [];
    for await (const file of glob(pattern, { cwd: cwd ? resolvePath(cwd) : currentCwd() })) {
      matches.push(file);
    }
    return matches.length > 0 ? matches.join("\n") : "未找到匹配文件";
  },
};
