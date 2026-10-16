import { readFile, readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { z } from "zod";
import { validateInput, outputLimitNote } from "../base.js";
import type { Tool } from "../base.js";
import { currentFileState, hashContent, resolvePath } from "../file-state.js";

const MAX_RESULT_CHARS = 30000;

const schema = z.object({
  path: z.string().describe("要读取的路径；传目录时改为列出目录条目"),
  offset: z.number().int().positive().optional().describe("起始行号，从 1 起，与输出行号一致，缺省从头读"),
  limit: z.number().int().positive().optional().describe("读取行数，缺省读到文件末尾"),
});

/** 读取文件内容，返回带行号的文本（后续编辑工具可引用行号） */
export const readTool: Tool = {
  name: "read",
  description:
    "读取文件内容，返回带行号的文本；path 传目录时改为列出目录条目。" +
    "大文件用 offset 加 limit 分段读。" +
    outputLimitNote(MAX_RESULT_CHARS),
  inputSchema: schema,
  isReadOnly: true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: MAX_RESULT_CHARS,
  truncationNote: "结果不完整，建议缩小范围：文件用 offset 与 limit 分段读，目录用 glob 按模式过滤",
  async execute(input, options) {
    const { path, offset = 1, limit } = validateInput<{
      path: string;
      offset?: number;
      limit?: number;
    }>(readTool, input);
    const file = resolvePath(path); // 相对路径基于工具执行上下文 cwd
    // 目录目标先识别：readFile 打在目录上只会抛 EISDIR 裸系统错误，模型无从纠偏。
    // 列出条目并提示读文件给具体路径、按模式找文件用 glob，按正常结果返回。
    // stat 失败时不抛裸系统错误：不存在与无法访问分开提示（口径同 grep）
    let target: Stats;
    try {
      target = await stat(file);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return `读取路径不存在：${path}`;
      return `读取路径无法访问：${path}（${e.message ?? "未知错误"}）`;
    }
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
    const contentHash = hashContent(content);
    // 记录版本令牌：内容已完整取出，部分读也照记 hash，写前据此比对内容。
    // 记版本的 stat 在读与 stat 之间文件被删时同样会抛裸 ENOENT，失败即跳过记版本
    const fileState = currentFileState();
    if (fileState) {
      try {
        const disk = await stat(file);
        fileState.setVersion(file, { size: disk.size, contentHash });
      } catch {
        // 文件在读取后立即被删：内容已拿到，正常返回，不记版本
      }
    }
    const lines = content.split("\n");
    const start = offset - 1;
    const end = limit !== undefined ? start + limit : lines.length;
    const selected = lines.slice(start, end);
    if (selected.length === 0) {
      // 越界反馈：offset 超出行数时返回空串与「读到空文件」不可区分，
      // 模型得不到反馈可能反复调 offset 空转
      return `起始行超出文件行数（共 ${lines.length} 行，offset 从 1 起）`;
    }
    const rendered = selected.map((line, i) => `${offset + i}\t${line}`).join("\n");
    // 读去重：同路径同区间、内容未变、且旧结果仍在上下文时回 stub，不重复回灌全文。
    // 「旧结果仍在上下文」由 Agent 保证——修剪/压缩/剥组摘除旧结果时同步摘除读记录
    // （FileState.retainReads），记录在即结果在。内容 hash 变了（文件被外部或本次
    // edit 改写）或区间不同则照常回全文。无调用身份（无 toolCallId）时不做去重。
    const toolCallId = options?.toolCallId;
    if (fileState && toolCallId) {
      const record = fileState.getRead(file, offset, limit);
      if (record && record.contentHash === contentHash) {
        return readUnchangedStub(offset, limit);
      }
      // 登记经 contextModifier 延后到结果交付：只有交付出去的确实是这段完整内容才登记。
      // 结果超上限时上文只留截断预览，直接不产修饰器；本次执行被中断/超时抢先结束时
      // 执行器丢弃结果、连带丢弃修饰器（见 Agent.executeToolInner）。否则同区间重读
      // 会回 stub，指向错误文本或截断预览。
      if (rendered.length <= MAX_RESULT_CHARS) {
        return {
          output: rendered,
          contextModifier: () => fileState.setRead(file, offset, limit, toolCallId, contentHash),
        };
      }
    }
    return rendered;
  },
};

/** 读去重命中时的回灌文本：指回上下文里仍在的旧结果，不重复回灌文件内容 */
function readUnchangedStub(offset: number, limit: number | undefined): string {
  const range = limit === undefined ? `第 ${offset} 行起` : `第 ${offset} 行起 ${limit} 行`;
  return `文件未变化：${range}的内容与上次读取一致，不重复回灌；上次结果仍在上文，直接引用即可。`;
}
