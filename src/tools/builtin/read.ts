import { readFile, readdir, stat } from "node:fs/promises";
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
    const file = resolvePath(path); // 相对路径基于工具执行上下文 cwd
    // 目录目标先识别：readFile 打在目录上只会抛 EISDIR 裸系统错误，模型无从纠偏。
    // 列出条目并提示读文件给具体路径、按模式找文件用 glob，按正常结果返回
    const target = await stat(file);
    if (target.isDirectory()) {
      const entries = await readdir(file, { withFileTypes: true });
      const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
      return [
        `「${path}」是目录，不是文件。目录下 ${entries.length} 个条目，带 / 的是子目录：`,
        ...names,
        "读文件内容请给出具体文件路径；按名称模式找文件用 glob 工具。",
      ].join("\n");
    }
    const content = await readFile(file, "utf8");
    // 记录版本令牌：完整读时记内容 hash 供抖动兜底；部分读只记 mtime+size
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
      // 越界反馈：offset 超出行数时返回空串与「读到空文件」不可区分，
      // 模型得不到反馈可能反复调 offset 空转
      return `起始行超出文件行数（共 ${lines.length} 行，offset 从 0 起）`;
    }
    return selected.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
  },
};
