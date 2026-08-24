import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { validateInput } from "../base.js";
import type { Tool } from "../base.js";
import { currentFileState, resolvePath } from "../file-state.js";

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
    const file = resolvePath(filePath); // 相对路径基于工具执行上下文 cwd
    const fileState = currentFileState();
    const write = async () => {
      // CAS 校验：磁盘 vs 本 agent 快照，冲突拒绝（DESIGN 7.6）
      const stale = fileState ? await fileState.assertWritable(file) : null;
      if (stale) return stale;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
      // 只刷自己的快照：其他 agent 仍持旧版本，写同一文件会冲突
      await fileState?.refreshVersion(file, content);
      return `已写入 ${file}`;
    };
    // per-path 锁关 TOCTOU：校验 + 写入 + 刷新快照一气呵成
    return fileState ? fileState.withFileLock(file, write) : write();
  },
};
