import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { validateInput } from "../base.js";
import type { Tool } from "../base.js";

const schema = z.object({
  path: z.string(),
  content: z.string(),
});

/** 写入文件，覆盖已有内容，自动创建父目录 */
export const writeTool: Tool = {
  name: "write",
  description: "写入文件，覆盖已有内容，自动创建父目录",
  inputSchema: schema,
  isReadOnly: false,
  requiresUserInteraction: false,
  maxResultSizeChars: 1000,
  async execute(input) {
    const { path: filePath, content } = validateInput<{ path: string; content: string }>(
      writeTool,
      input,
    );
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return `已写入 ${filePath}`;
  },
};
