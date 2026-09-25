import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { validateInput } from "../base.js";
import type { Tool } from "../base.js";
import { currentFileState, hashContent, resolvePath } from "../file-state.js";

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
  maxResultSizeChars: 30000,
  async execute(input) {
    const { path, offset = 0, limit } = validateInput<{
      path: string;
      offset?: number;
      limit?: number;
    }>(readTool, input);
    const file = resolvePath(path); // 相对路径基于工具执行上下文 cwd（DESIGN 7.6 配套）
    const content = await readFile(file, "utf8");
    // 记录版本令牌（DESIGN 7.6）：完整读时记内容 hash 供抖动兜底；部分读只记 mtime+size
    const fileState = currentFileState();
    if (fileState) {
      const disk = await stat(file);
      fileState.setVersion(file, {
        mtimeMs: disk.mtimeMs,
        size: disk.size,
        contentHash: limit === undefined ? hashContent(content) : undefined,
      });
    }
    const lines = content.split("\n");
    const end = limit !== undefined ? offset + limit : lines.length;
    const selected = lines.slice(offset, end);
    if (selected.length === 0) {
      // 越界反馈（E93）：offset 超出行数时返回空串与「读到空文件」不可区分，
      // 模型得不到反馈可能反复调 offset 空转
      return `起始行超出文件行数（共 ${lines.length} 行，offset 从 0 起）`;
    }
    return selected.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
  },
};
