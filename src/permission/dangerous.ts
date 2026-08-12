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

/** 危险模式：正则 + 说明 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\$\(|\x60/, reason: "命令替换（$() 或反引号）" },
  { pattern: /[<>]=?\(/, reason: "进程替换（<() / >()）" },
  { pattern: /\bIFS\s*=/, reason: "IFS 环境变量注入" },
  { pattern: /\/proc\//, reason: "访问 /proc 敏感路径" },
];

/** 检测命令是否危险；返回是否危险及原因 */
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

  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { dangerous: true, reason };
    }
  }

  return { dangerous: false };
}

/** 判断命令是否以某个内建命令开头（后跟空白或结尾） */
function startsWithBuiltin(command: string, builtin: string): boolean {
  return new RegExp(`^${escapeRegExp(builtin)}(\\s|$)`).test(command);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
