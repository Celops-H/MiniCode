/**
 * 危险命令检测（轻量）：硬编码黑名单 + 正则模式。
 * 用于 bash 工具执行前的安全检查。tree-sitter AST 语法树解析作为后续增强。
 * Windows 上 bash 工具经 spawn(shell:true) 由 COMSPEC 指定的 shell 执行，命令语法随
 * 实际 shell 变化，正则模式带 shells 生效范围（如 cmd 无命令替换语法）。
 */

export interface DangerousCheckResult {
  dangerous: boolean;
  /** 危险原因，供拒绝理由反馈模型 */
  reason?: string;
}

/** bash 工具实际执行方的命令语义归类：bash（POSIX 全量语法）、cmd、powershell */
export type CommandShellKind = "bash" | "cmd" | "powershell";

/**
 * 按平台与环境归类 bash 工具实际执行方的 shell 语义。
 * 非 Windows 一律按 bash 判定（POSIX shell 家族，模式全开，保守）；
 * Windows 取 COMSPEC 可执行名归类（Node 的 spawn(shell:true) 同样取 comspec，
 * 与 environment.ts 的报告口径一致）：cmd.exe 按 cmd，PowerShell 系按 powershell，
 * 其余取值（误把 COMSPEC 指到 bash 等罕见配置）按 bash 保守全拦。
 * @param opts 平台与环境注入（测试用），缺省读 process.platform 与 process.env
 */
export function resolveCommandShell(opts?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): CommandShellKind {
  const platform = opts?.platform ?? process.platform;
  const env = opts?.env ?? process.env;
  if (platform !== "win32") return "bash";
  // 空串与缺失同样回退 cmd.exe（|| 语义），与 Node spawn(shell:true) 的取值行为一致
  const base = (env.COMSPEC || "cmd.exe").split(/[\\/]/).pop()!.toLowerCase();
  if (base.includes("powershell") || base.includes("pwsh")) return "powershell";
  return base.includes("cmd") ? "cmd" : "bash";
}

/** 危险内建命令：把参数当代码执行，而非普通命令（eval/source 为 bash 系，iex 为 PowerShell 系） */
const DANGEROUS_BUILTINS = ["eval", "source", "coproc", "zmodload", "zpty", "iex", "invoke-expression"];

/** 危险模式：正则 + 说明。quoteStrippedCommand 标记的只在引号外匹配；shells 限定生效的 shell（缺省全生效） */
const DANGEROUS_PATTERNS: Array<{
  pattern: RegExp;
  reason: string;
  quoteStrippedCommand?: boolean;
  shells?: readonly CommandShellKind[];
}> = [
  // $() 与反引号：bash 的命令替换；PowerShell 的 $( ) 子表达式照常拦，反引号在 PS 里
  // 是转义符、本身无害，按保守口径一并拦；cmd 无命令替换语法，两符号只是字面字符
  // （node -e 写模板字符串高频出现），不拦
  { pattern: /\$\(|\x60/, reason: "命令替换（$() 或反引号）", shells: ["bash", "powershell"] },
  // 进程替换 <( / >(：bash 专属语法，cmd/PowerShell 均无。引号内是字面文本不生效
  // （node -e 的 f=>({ 在引号内，剔除后不再误拦）；引号外词中的 =<(、=>( 在 bash 里
  // 仍是真进程替换，必须拦截——形态豁免只针对引号剔除，不做前缀字符豁免
  // （($|=> 等前缀后紧跟 <( 的都是真进程替换）
  { pattern: /[<>](?=\()/, reason: "进程替换（<() / >()）", quoteStrippedCommand: true, shells: ["bash"] },
  // IFS 注入与 /proc 访问是 POSIX 概念，cmd/PowerShell 下无此语义，只是字面文本，不拦
  { pattern: /\bIFS\s*=/, reason: "IFS 环境变量注入", shells: ["bash"] },
  { pattern: /\/proc\//, reason: "访问 /proc 敏感路径", shells: ["bash"] },
];

/** 剔除引号段（单/双，双引号容忍转义），供引号内不生效的模式匹配用：
 *  引号不配对时残段留在原文里照常参与匹配，不会漏检 */
export function stripQuotedSpans(command: string): string {
  return command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " ");
}

/**
 * 检测命令是否危险（硬编码黑名单 + 正则模式）。
 * @param command 待检测的命令原文
 * @param shell 实际执行方的 shell 语义（resolveCommandShell 的归类），缺省按 bash 全量判定
 * @returns 检测结果（是否危险 + 危险原因）
 */
export function checkDangerousCommand(command: string, shell: CommandShellKind = "bash"): DangerousCheckResult {
  // 内建名按小写比较：Windows 可执行名查找不分大小写，EVAL 与 eval 等效
  const trimmed = command.trimStart().toLowerCase();

  for (const builtin of DANGEROUS_BUILTINS) {
    if (startsWithBuiltin(trimmed, builtin)) {
      return { dangerous: true, reason: `危险内建命令：${builtin}` };
    }
  }

  // `. script` 是 source 别名（点 + 空格）；`.foo`（隐藏文件）不危险
  if (/^\.\s/.test(trimmed)) {
    return { dangerous: true, reason: "危险内建命令：.（source 别名）" };
  }

  for (const { pattern, reason, quoteStrippedCommand, shells } of DANGEROUS_PATTERNS) {
    if (shells && !shells.includes(shell)) continue;
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
