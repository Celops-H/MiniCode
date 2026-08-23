import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { validateInput } from "../base.js";
import type { Tool } from "../base.js";
import { currentFileState } from "../file-state.js";

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
    const fileState = currentFileState();
    const write = async () => {
      // CAS 校验：磁盘 vs 本 agent 快照，冲突拒绝（DESIGN 7.6）
      const stale = fileState ? await fileState.assertWritable(filePath) : null;
      if (stale) return stale;
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
      // 只刷自己的快照：其他 agent 仍持旧版本，写同一文件会冲突
      await fileState?.refreshVersion(filePath, content);
      return `已写入 ${filePath}`;
    };
    // per-path 锁关 TOCTOU：校验 + 写入 + 刷新快照一气呵成
    return fileState ? fileState.withFileLock(filePath, write) : write();
  },
};
