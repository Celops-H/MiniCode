import { glob } from "node:fs/promises";
import { z } from "zod";
import { validateInput } from "../base.js";
import type { Tool } from "../base.js";

const schema = z.object({
  pattern: z.string(),
  /** 搜索起始目录，默认当前工作目录 */
  path: z.string().optional(),
});

/** 按 glob 模式查找文件，返回匹配路径列表 */
export const globTool: Tool = {
  name: "glob",
  description: "按 glob 模式查找文件，返回匹配路径列表",
  inputSchema: schema,
  isReadOnly: true,
  isConcurrencySafe: () => true,
  requiresUserInteraction: false,
  maxResultSizeChars: 10000,
  async execute(input) {
    const { pattern, path: cwd } = validateInput<{ pattern: string; path?: string }>(globTool, input);
    const matches: string[] = [];
    for await (const file of glob(pattern, { cwd: cwd ?? process.cwd() })) {
      matches.push(file);
    }
    return matches.length > 0 ? matches.join("\n") : "未找到匹配文件";
  },
};
