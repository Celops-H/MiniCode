/**
 * 危险命令检测（轻量）：硬编码黑名单 + 正则模式。
 * 用于 bash 工具执行前的安全检查。tree-sitter AST 语法树解析作为后续增强。
 */

export interface DangerousCheckResult {
  dangerous: boolean;
  /** 危险原因，供拒绝理由反馈模型 */
  reason?: string;
}

/** 危险内建命令：把参数当代码执行，而非普通命令 */
const DANGEROUS_BUILTINS = ["eval", "source", "coproc", "zmodload", "zpty"];

/** 危险模式：正则 + 说明。quoteStrippedCommand 标记的只在引号外匹配 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string; quoteStrippedCommand?: boolean }> = [
  { pattern: /\$\(|\x60/, reason: "命令替换（$() 或反引号）" },
  // 进程替换 <( / >(：引号内是字面文本不生效（node -e 的 f=>({ 在引号内，剔除后不再
  // 误拦）；引号外词中的 =<(、=>( 在 bash 里仍是真进程替换，必须拦截——形态豁免只针对
  // 引号剔除，不做前缀字符豁免（($|=> 等前缀后紧跟 <( 的都是真进程替换）
  { pattern: /[<>](?=\()/, reason: "进程替换（<() / >()）", quoteStrippedCommand: true },
  { pattern: /\bIFS\s*=/, reason: "IFS 环境变量注入" },
  { pattern: /\/proc\//, reason: "访问 /proc 敏感路径" },
];

/** 剔除引号段（单/双，双引号容忍转义），供引号内不生效的模式匹配用：
 *  引号不配对时残段留在原文里照常参与匹配，不会漏检 */
export function stripQuotedSpans(command: string): string {
  return command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " ");
}

/**
 * 检测命令是否危险（硬编码黑名单 + 正则模式）。
 * @param command 待检测的命令原文
 * @returns 检测结果（是否危险 + 危险原因）
 */
export function checkDangerousCommand(command: string): DangerousCheckResult {
  const trimmed = command.trimStart();

  for (const builtin of DANGEROUS_BUILTINS) {
    if (startsWithBuiltin(trimmed, builtin)) {
      return { dangerous: true, reason: `危险内建命令：${builtin}` };
    }
  }

  // `. script` 是 source 别名（点 + 空格）；`.foo`（隐藏文件）不危险
  if (/^\.\s/.test(trimmed)) {
    return { dangerous: true, reason: "危险内建命令：.（source 别名）" };
  }

  for (const { pattern, reason, quoteStrippedCommand } of DANGEROUS_PATTERNS) {
    const target = quoteStrippedCommand ? stripQuotedSpans(command) : command;
    if (pattern.test(target)) {
      return { dangerous: true, reason };
    }
  }

  return { dangerous: false };
}

/**
 * 判断命令是否以某个内建命令开头。
 * @param command 命令原文
 * @param builtin 内建命令名
 * @returns 是否以该内建命令开头（后跟空白或结尾）
 */
function startsWithBuiltin(command: string, builtin: string): boolean {
  return new RegExp(`^${escapeRegExp(builtin)}(\\s|$)`).test(command);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
