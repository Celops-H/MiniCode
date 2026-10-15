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

/**
 * 剔除引号段（双引号容忍转义），供引号内不生效的模式匹配用。
 * 单引号按 shell 语义区分：bash 与 PowerShell 把单引号当引号，一并剥除；cmd 不把单引号
 * 当引号（echo hi '>' out.txt 里的 '>' 仍是重定向符号），只剥双引号，否则重定向漏判。
 * 引号不配对时残段留在原文里照常参与匹配，不会漏检。双引号段各 shell 沿用同一转义口径
 * （\" 视为转义引号），cmd 不把 \ 当转义符，echo "a\"> f 这类形态可能漏判重定向，属已知边界。
 * @param shell 命令实际执行方的 shell 语义，缺省按 bash（单双都剥）
 */
export function stripQuotedSpans(command: string, shell: CommandShellKind = "bash"): string {
  if (shell === "cmd") return command.replace(/"(?:[^"\\]|\\.)*"/g, " ");
  return command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " ");
}

/**
 * 检测命令是否危险（硬编码黑名单 + 正则模式）。
 * 内建名判定先剥包装命令、变量赋值与分组符号，再按段首真实命令词判
 * （与只读守卫同口径，防 `sudo eval`、`FOO=1 eval`、`(eval x)` 等形态绕过首词判定）。
 * @param command 待检测的命令原文
 * @param shell 实际执行方的 shell 语义（resolveCommandShell 的归类），缺省按 bash 全量判定
 * @returns 检测结果（是否危险 + 危险原因）
 */
export function checkDangerousCommand(command: string, shell: CommandShellKind = "bash"): DangerousCheckResult {
  const head = commandHeadWord(command);
  if (head !== undefined) {
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

/** 命令段首真实命令词：剥包装、赋值与分组符号后归一取首词；空命令返回 undefined */
function commandHeadWord(command: string): string | undefined {
  const words = command.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  const { rest, queried } = stripCommandPrefix(words);
  if (queried || rest.length === 0) return undefined;
  return normalizeCommandWord(rest[0]!);
}

/** 包装命令：不改写后续命令词，剥开按真实命令词判定（sudo/env/nohup 等，跨 shell 归并） */
const WRAPPER_COMMANDS = new Set(["sudo", "env", "nohup", "nice", "stdbuf", "timeout", "call"]);

/**
 * 包装命令的取值选项：其后一个 token 是该选项的参数，随选项一并跳过。
 * 按包装命令分设，不并成一张全局表：同名旗标在不同命令下语义不同，
 * env -i 清空环境、sudo -e 编辑文件都是无参旗标，只有 stdbuf 的 -i/-e 带参数，
 * 合表会把无参旗标的后继命令词当参数吞掉，漏判写命令。
 * 表项收短旗标与长旗标的分写形态（--signal 9）；长旗标的等号粘连形态（--signal=9）
 * 本身是一个 token，随选项一并剥掉，不入表。
 */
const WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  sudo: new Set([
    "-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--close-from",
    "-T", "--command-timeout", "-D", "--chdir", "-R", "--chroot",
    "-h", "--host", "-r", "--role", "-t", "--type", "-U", "--other-user",
  ]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-k", "--kill-after", "-s", "--signal"]),
  stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
};

/**
 * 命令词归一：取路径基名、剥首尾分组符号与 cmd 的 @ 静默前缀、剥 Windows 可执行后缀、转小写。
 * Windows 的可执行名查找不分大小写与分隔符（cmd.exe / C:\...\cmd.exe 与 cmd 等效），
 * 统一归一后比较，防拼写变体绕过（@del、括号包住的首词同为常见拼写形态）；
 * POSIX 下多余的大写形态本就不存在，按写拦不误伤。
 */
export function normalizeCommandWord(word: string): string {
  const base = word.split(/[\\/]/).pop()!;
  const cleaned = base.replace(/^[@({]+/, "").replace(/[)}]+$/, "");
  return cleaned.replace(/\.(exe|com|cmd|bat)$/i, "").toLowerCase();
}

/**
 * 剥开命令段首的包装与分组：分组符号词、变量赋值前缀、包装命令（含选项与取值选项的参数）。
 * 与只读守卫共用同一口径，防连乘包装（sudo env FOO=1 cmd）绕过首词判定。
 * @param words 命令段分词（含包装前缀）
 * @returns rest 剥开后的词表；queried 为 true 表示 command -v/-V 只查询命令路径、不执行后续词
 */
export function stripCommandPrefix(words: string[]): { rest: string[]; queried: boolean } {
  const rest = [...words];
  // 外层循环：连乘的包装（sudo env FOO=1 cmd）逐层剥开
  while (rest.length > 0) {
    // 段首的独立分组符号词逐层剥干净（( rm x)、{ rm x、@ del x——含剥包装后露出的
    // call ( del x），首词判定看其后真实命令词
    while (rest.length > 0 && /^[@({]+$/.test(rest[0]!)) rest.shift();
    if (rest.length === 0) break;
    const head = normalizeCommandWord(rest[0]!);
    // command 的旗标只有 -p/-v/-V（可组合，如 -pv）：带 -v/-V 是查询命令路径，不执行
    // 后续词，整体按查询放行；只有 -p 时剥掉 command 与其旗标（-p 用默认 PATH 执行后续命令）
    if (head === "command") {
      let i = 1;
      let query = false;
      while (i < rest.length && /^-[pvV]+$/.test(rest[i]!)) {
        if (/[vV]/.test(rest[i]!)) query = true;
        i++;
      }
      // bash 内建的 -- 结束选项标记：与旗标一并剥掉后按后续命令词判定
      if (rest[i] === "--") i++;
      if (query) return { rest, queried: true };
      rest.splice(0, i);
      continue;
    }
    const isWrapper =
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || WRAPPER_COMMANDS.has(head);
    if (!isWrapper) break;
    rest.shift();
    const valueFlags = WRAPPER_VALUE_FLAGS[head];
    // 剥包装后继续吞选项与赋值；取值选项连参数一起吞
    while (rest.length > 0) {
      const word = rest[0]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
        rest.shift();
      } else if (word.startsWith("-")) {
        rest.shift();
        if (valueFlags?.has(word)) rest.shift();
      } else {
        break;
      }
    }
    // timeout 的时长排在选项之后（timeout 10 rm x、timeout -k 5 10 rm x），吞完选项再剥一次
    if (head === "timeout" && /^\d+[smhd]?$/.test(rest[0] ?? "")) rest.shift();
  }
  return { rest, queried: false };
}
