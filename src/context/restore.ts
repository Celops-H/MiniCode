/**
 * 压缩/修剪后回注最近读过的文件：旧工具结果被清出上下文后，模型只能重读文件，
 * 重复读回灌的字符是重复读的大头。这里把读状态里最近读过的文件按当前磁盘内容
 * 重新载入上下文，模型直接引用即可。条数与预算由压缩配置给出，见 Agent.doCompact。
 */
import type { Message } from "../core/index.js";

/** 回注消息的标记前缀（压缩/修剪后由系统注入，source: "system"） */
export const RESTORE_MARKER = "【已读文件回注】";

/** 判断一条消息是否为已读文件回注（系统注入）：内容源自压缩前的读结果，不是新的对话增量 */
export function isRestoreMessage(message: Message): boolean {
  return (
    message.role === "user" &&
    message.source === "system" &&
    typeof message.content === "string" &&
    message.content.startsWith(RESTORE_MARKER)
  );
}

/** 回注前言：说明来路，避免模型当成新的用户指令或再读一遍 */
const RESTORE_PREAMBLE = "以下文件压缩前读过，内容已按磁盘当前状态重新载入，可直接引用，不必重读：";

/** 单文件截断说明（附在截断的文件末尾） */
const TRUNCATED_NOTE = "（文件过长，此处按行截断；需要更多内容用 read 带 offset 续读）";

/** 文件段之间的分隔符 */
const SECTION_SEPARATOR = "\n\n";

/** 回注预算 */
export interface RestoreOptions {
  /** 单文件字符上限，超出按行边界截断 */
  maxCharsPerFile: number;
  /** 回注总字符预算，装不下的文件整条跳过 */
  maxTotalChars: number;
}

/** 待回注的文件 */
export interface RestoreFile {
  path: string;
  content: string;
}

/** 回注组装结果 */
export interface RestoreResult {
  /** 回注消息正文（含前言）；无可用文件时为空串 */
  text: string;
  /** 实际回注且未截断的文件，调用方据此重新登记读去重记录 */
  complete: RestoreFile[];
}

/**
 * 组装回注正文：逐文件按行号格式化（行号口径与 read 一致，模型可按行引用），
 * 单文件超上限按行边界截断并附截断说明，累计超总预算的文件整条跳过、不回注半条。
 * @param files 待回注文件，按调用方给的顺序（最近读取在前）
 * @param options 单文件与总字符预算
 * @returns 回注正文，以及未截断的那部分文件
 */
export function buildRestore(files: RestoreFile[], options: RestoreOptions): RestoreResult {
  const complete: RestoreFile[] = [];
  const sections: string[] = [];
  let used = RESTORE_PREAMBLE.length;
  for (const file of files) {
    const formatted = formatRestoreFile(file, options.maxCharsPerFile);
    // 每段另计分隔符：预算按最终正文长度算，不留出分隔符余量会超配置的总预算
    if (used + SECTION_SEPARATOR.length + formatted.text.length > options.maxTotalChars) continue;
    sections.push(formatted.text);
    used += SECTION_SEPARATOR.length + formatted.text.length;
    if (!formatted.truncated) complete.push(file);
  }
  if (sections.length === 0) return { text: "", complete: [] };
  return { text: [RESTORE_PREAMBLE, ...sections].join(SECTION_SEPARATOR), complete };
}

/** 单文件回注文本：路径行 + 带行号正文；超上限按行边界截断，尾部附截断说明 */
function formatRestoreFile(file: RestoreFile, maxChars: number): { text: string; truncated: boolean } {
  const header = `文件：${file.path}`;
  const lines: string[] = [];
  let used = header.length;
  let truncated = false;
  for (const [index, line] of file.content.split("\n").entries()) {
    const numbered = `${index + 1}\t${line}`;
    // 每个行项另计一个换行符，保证结果不超过上限
    if (used + numbered.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    lines.push(numbered);
    used += numbered.length + 1;
  }
  const body = [header, ...lines].join("\n");
  return { text: truncated ? `${body}\n${TRUNCATED_NOTE}` : body, truncated };
}
