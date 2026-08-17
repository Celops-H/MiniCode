import { readFile } from "node:fs/promises";
import { z } from "zod";
import { validateInput } from "../base.js";
import type { Tool } from "../base.js";

const schema = z.object({
  path: z.string(),
  /** 起始行号（从 0 起） */
  offset: z.number().int().nonnegative().optional(),
  /** 读取行数 */
  limit: z.number().int().positive().optional(),
});

/** 读取文件内容，返回带行号的文本（后续编辑工具可引用行号） */
export const readTool: Tool = {
  name: "read",
  description: "读取文件内容，返回带行号的文本",
  inputSchema: schema,
  isReadOnly: true,
  isConcurrencySafe: () => true,
  requiresUserInteraction: false,
  maxResultSizeChars: 30000,
  async execute(input) {
    const { path, offset = 0, limit } = validateInput<{
      path: string;
      offset?: number;
      limit?: number;
    }>(readTool, input);
    const content = await readFile(path, "utf8");
    const lines = content.split("\n");
    const end = limit !== undefined ? offset + limit : lines.length;
    const selected = lines.slice(offset, end);
    return selected.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
  },
};
