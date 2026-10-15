/**
 * 危险命令检测（轻量）：硬编码黑名单 + 正则模式。
 * 用于 bash 工具执行前的安全检查。tree-sitter AST 语法树解析作为后续增强。
 * Windows 上 bash 工具经 spawn(shell:true) 由 COMSPEC 指定的 shell 执行，命令语法随
 * 实际 shell 变化，正则模式带 shells 生效范围（如 cmd 无命令替换语法）。
 */
import { normalizeCommandWord, stripCommandPrefix } from "../core/index.js";

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

/**
 * 剔除引号段（双引号容忍转义），供引号内不生效的模式匹配用。
 * 单引号按 shell 语义区分：bash 与 PowerShell 把单引号当引号，一并剥除；cmd 不把单引号
 * 当引号（echo hi '>' out.txt 里的 '>' 仍是重定向符号），只剥双引号，否则重定向漏判。
 * 引号不配对时残段留在原文里照常参与匹配，不会漏检。双引号段各 shell 沿用同一转义口径
 * （\" 视为转义引号），cmd 不把 \ 当转义符，其后的引号在 cmd 下照常闭合引号：echo "a\" > f"
 * 的 > 是 cmd 的真重定向，剥除却把这一整段当引号内容删掉，重定向漏判，属已知边界。
 * @param shell 命令实际执行方的 shell 语义，缺省按 bash（单双都剥）
 */
export function stripQuotedSpans(command: string, shell: CommandShellKind = "bash"): string {
  if (shell === "cmd") return command.replace(/"(?:[^"\\]|\\.)*"/g, " ");
  return command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " ");
}

/**
 * 检测命令是否危险（硬编码黑名单 + 正则模式）。
 * 内建名判定按 ; | & 与换行切段，逐段剥包装命令、变量赋值与分组符号后取段首真实命令词
 * （与只读守卫同口径，防 `sudo eval`、`FOO=1 eval`、`printf x; eval "$y"`、多行 `. cfg`
 * 等形态绕过首词判定）；切段前先按 shell 语义剔除引号段，防引号内字面文本误判。
 * @param command 待检测的命令原文
 * @param shell 实际执行方的 shell 语义（resolveCommandShell 的归类），缺省按 bash 全量判定
 * @returns 检测结果（是否危险 + 危险原因）
 */
export function checkDangerousCommand(command: string, shell: CommandShellKind = "bash"): DangerousCheckResult {
  for (const head of commandHeadWords(command, shell)) {
    if (DANGEROUS_BUILTINS.includes(head)) {
      return { dangerous: true, reason: `危险内建命令：${head}` };
    }
    // 段首 `.` 是 source 别名（`. script` 点与脚本名分写成两个词）；
    // `.foo`（隐藏文件）与 `./x`（相对路径）归一后首词不是 `.`，不危险
    if (head === ".") {
      return { dangerous: true, reason: "危险内建命令：.（source 别名）" };
    }
  }

  for (const { pattern, reason, quoteStrippedCommand, shells } of DANGEROUS_PATTERNS) {
    if (shells && !shells.includes(shell)) continue;
    const target = quoteStrippedCommand ? stripQuotedSpans(command, shell) : command;
    if (pattern.test(target)) {
      return { dangerous: true, reason };
    }
  }

  return { dangerous: false };
}

/**
 * 各命令段段首的真实命令词：按 ; | & 与换行切段（与只读守卫同口径），
 * 切段前先按 shell 语义剔除引号段，引号内的分隔符与内建名是字面文本不参与判定；
 * 再逐段剥包装、赋值与分组符号后归一取首词。空段与纯赋值段跳过。
 * @param command 命令原文
 * @param shell 实际执行方的 shell 语义（引号剔除口径用）
 * @returns 各段段首命令词（顺序同命令段）
 */
function commandHeadWords(command: string, shell: CommandShellKind): string[] {
  const heads: string[] = [];
  for (const segment of stripQuotedSpans(command, shell).split(/[|;&\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const { rest, queried } = stripCommandPrefix(words);
    if (queried || rest.length === 0) continue;
    heads.push(normalizeCommandWord(rest[0]!));
  }
  return heads;
}
