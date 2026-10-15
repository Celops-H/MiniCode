/**
 * 只读 agent 的写操作判定（轻量）：工具元数据 + bash 写命令模式。
 * 用于只读派生子 agent（spawn_agent 只读声明）的工具执行前拦截。
 * 与危险命令检查同为轻量守卫，不做完整 shell 解析，已知边界：
 * - awk/perl/python -c 等一行流脚本引号内的写行为不检测（引号段剔除是为
 *   「echo "rm" 不误拦」服务的，一行流里的真实代码无法与字面文本区分）；
 *   同源边界：引号包住的命令词、脚本路径与旗标也随引号段剔除而逃过判定
 *   （"bash x.sh" 整串、"C:\...\bash.exe" -c、python "x.py"、curl "-o"）；
 * - 引号段按 shell 语义剥除（见 stripQuotedSpans）：bash 与 PowerShell 把单引号当引号，
 *   cmd 不把单引号当引号。同一条命令在 cmd 与非 cmd 语义下判定不同：echo hi '>' out.txt
 *   在 cmd 语义下判「命令含重定向写文件」，在 bash/PowerShell 语义下放行；
 * - 取值旗标的参数被引号包住时随引号段剔除消失，剥包装把真命令词当该旗标的参数
 *   吞掉，同样判只读放行（stdbuf -o "L" rm x、sudo -r "x" rm y），与上条同源；
 * - $( ) 命令替换内的写命令不检测，由权限管线的危险命令检查兜底
 *   （该检查随管线存在，无管线的 agent 无此兜底）。兜底按实际 shell 语义生效：
 *   cmd 归类下 bash -c 引号内的替换不被危险命令检查拦，只读侧由 shell 执行体
 *   整体拒绝兜住，root 侧该形态落入正常审批链；
 * - cmd 的 doskey 宏与 PowerShell 的 Set-Alias 可把写命令改名（如 sal wd Remove-Item），
 *   改名后的命令词绕过黑名单，不做别名反解；
 * - 写命令黑名单按命令词枚举守卫，跨 shell 语义归并（见 WRITE_COMMAND_WORDS 注释）；
 *   脚本执行（shell 家族、cscript/wscript、解释器脚本文件与 awk/sed -f）整体拒绝，
 *   包管理器（npm/pnpm/yarn/bun/corepack）按子命令判定、npx 家族（npx/pnpx/bunx）
 *   整体拒绝，落盘出口（下载、sort 输出文件、certutil 编解码）与持久化写（注册表、
 *   setx、计划任务、服务控制）按形态判定，cmd 的 if/for 语句按括号分组切开、剥包装后取内层命令
 *   再判（段内非分组的字面括号一并切开，宁可保守拒绝；未识别的 if 条件形态放行），
 *   见 segmentWriteVerdict 各分支；
 * - ssh 的远端命令不判定：`ssh host rm x` 与 `ssh host 'rm x'`（引号包住的整串）同属边界，
 *   远端执行的写入不在本机守卫范围，只读 agent 的远端读由内置工具覆盖。
 */
import {
  normalizeCommandWord,
  resolveCommandShell,
  stripCommandPrefix,
  stripQuotedSpans,
  type CommandShellKind,
} from "./dangerous.js";

/** 无文件写副作用、只读 agent 可用的状态类工具（协作调度与会话内任务管理） */
const STATE_TOOL_ALLOW = new Set([
  "spawn_agent", "send_message", "followup_task", "list_agents", "wait_agent", "interrupt_agent",
  "todo", "bash_task",
]);

/**
 * 判定一次工具调用是否为只读 agent 不允许的写操作。
 * @param toolName 工具名
 * @param toolIsReadOnly 工具的只读元数据（Tool.isReadOnly；外部工具为 false、缺省视为副作用未知）
 * @param command bash 命令原文（非 bash 工具传 undefined）
 * @param shell 命令实际执行方的 shell 语义，缺省按当前进程解析（COMSPEC/platform）
 * @returns 违规原因（允许执行返回 undefined）
 */
export function readOnlyToolViolation(
  toolName: string,
  toolIsReadOnly: boolean | undefined,
  command?: string,
  shell?: CommandShellKind,
): string | undefined {
  // bash 单独走命令级判定（只读命令可用，写命令拒绝）
  if (toolName === "bash") {
    return command === undefined ? undefined : bashWriteViolation(command, shell ?? resolveCommandShell());
  }
  if (toolIsReadOnly === true) return undefined;
  if (STATE_TOOL_ALLOW.has(toolName)) return undefined;
  return toolIsReadOnly === false ? `工具 ${toolName} 具有写副作用` : `工具 ${toolName} 副作用未知`;
}

/**
 * 判定 bash 工具命令是否为写命令：重定向（空设备除外）或命令段命中写命令黑名单。
 * 按 ; | & 换行切段逐段判定，管道右侧的 tee、xargs 后的写命令同样命中；
 * 引号内字面文本剔除后匹配（echo "rm" 不误拦）。
 * Windows 上 bash 工具实际由 COMSPEC 的 shell 执行：cmd/PowerShell 的空设备是 NUL
 * （内核层落设备），与 /dev/null 同等豁免；bash 语义下 nul 是普通文件名，不豁免。
 * @param command 命令原文
 * @param shell 命令实际执行方的 shell 语义
 * @returns 违规原因；只读安全返回 undefined
 */
function bashWriteViolation(command: string, shell: CommandShellKind): string | undefined {
  let stripped = stripQuotedSpans(command, shell);
  // 丢弃输出的重定向不是写（cmd 2>/dev/null、cmd 2>nul），先摘除再判定，防高频安全用法误拦
  // nul 不认扩展名形态（nul.txt 在 NT 上是普通文件）；nul: 带冒号的设备写法一并豁免
  stripped = stripped.replace(/>{1,2}\s*\/dev\/null\b/g, " ");
  if (shell !== "bash") stripped = stripped.replace(/>{1,2}\s*nul(?![.\w])/gi, " ");
  // 重定向到文件：> >> 2> &> 等（>&2 / 2>&1 是 fd 复制不写文件；
  // >( 进程替换由危险命令检查拦截——该检查挂在权限管线，管线缺失时不兜底）
  if (/>{1,2}(?!&\d)(?!\()/.test(stripped)) return "命令含重定向写文件";
  for (const segment of stripped.split(/[|;&\n]/)) {
    // cmd 的括号只在 if/for 语句里是命令分组，其余位置是字面文本（echo (del)、findstr (copy)）
    const parts = shell === "cmd" && isCmdIfForSegment(segment) ? segment.split(/[()]/) : [segment];
    for (const part of parts) {
      const words = part.trim().split(/\s+/).filter(Boolean);
      const verdict = segmentWriteVerdict(words, shell);
      if (verdict) return verdict;
    }
  }
  return undefined;
}

/** shell 家族与 Windows 脚本宿主：调用即执行内层代码（-c 内联、脚本文件、stdin），整体拒绝 */
const SCRIPT_HOST_WORDS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish", "cscript", "wscript"]);

/** reg 写子命令：注册表持久化写，query/compare 等查询形态放行 */
const REG_WRITE_SUBCOMMANDS = new Set(["add", "delete", "copy", "save", "restore", "load", "unload", "import", "export"]);

/** schtasks 写操作旗标：计划任务持久化写，/query 等查询保持放行 */
const SCHTASKS_WRITE_FLAGS = new Set(["/create", "/delete", "/change", "/run", "/end"]);

/** sc.exe 只读子命令（查询与显示形态），其余子命令按服务控制写拒绝 */
const SC_READ_SUBCOMMANDS = new Set([
  "query", "queryex", "qc", "qdescription", "qfailure", "qfailureflag", "qsidtype", "qprivs",
  "qtriggerinfo", "qpreferrednode", "qmanagedaccount", "qprotection", "quserservice",
  "interrogate", "enumdepend", "sdshow", "showsid", "getdisplayname", "getkeyname", "querylock",
]);

/** npm 家族包管理器：安装写 node_modules 与锁文件，run/exec 执行任意脚本，按子命令判定 */
const PACKAGE_MANAGER_WORDS = new Set(["npm", "pnpm", "yarn", "bun", "corepack"]);

/** 临时包执行器：包从远端取来即执行，包来源与脚本内容均无法核验，整体拒绝 */
const PACKAGE_EXEC_WORDS = new Set(["npx", "pnpx", "bunx"]);

/** 包管理器只读子命令：读本地清单或远端元数据，不落盘、不执行脚本（audit 的 fix 子形态见分支） */
const PKG_READ_SUBCOMMANDS = new Set([
  "ls", "list", "ll", "la", "why", "view", "info", "show", "outdated", "audit", "doctor",
  "help", "root", "bin", "prefix", "explain", "repo", "search", "ping", "whoami", "fund",
  "bugs", "licenses", "dist-tags",
]);

/** 包管理器安装与依赖变更子命令：写 node_modules 与锁文件 */
const PKG_INSTALL_SUBCOMMANDS = new Set([
  "install", "i", "ci", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade",
  "dedupe", "prune", "link", "unlink", "publish", "patch", "set", "init", "create", "import",
  "rebuild",
]);

/** 包管理器脚本执行子命令：跑 package.json 脚本、临时包或任意二进制 */
const PKG_EXEC_SUBCOMMANDS = new Set(["run", "run-script", "exec", "x", "dlx"]);

/** 脚本解释器与各自的一行流旗标判定：旗标含义随解释器不同（python 的 -E 是忽略环境
 *  变量，perl 的 -E 才是内联执行），按命令词分设；命中一行流即放行，否则出现脚本操作数即拒绝 */
const INTERPRETER_INLINE_FLAGS: Record<string, (word: string) => boolean> = {
  // python 内联只有 -c（-m 执行模块、-E/-B 均非内联，带脚本操作数按文件执行拦）；
  // 版本化拼写（python3、python3.12、py3.12）按基线名归一，见 interpreterBase
  python: (w) => w === "-c",
  py: (w) => w === "-c",
  node: (w) => w === "-e" || w === "-p" || /^--(eval|print)(=|$)/.test(w),
  // deno 的一行流是 eval 子命令（deno eval "code"），run 与脚本参数走操作数判定
  deno: (w) => w === "eval",
  // tsx 转发 node 参数，一行流旗标同 node
  tsx: (w) => w === "-e" || w === "-p" || /^--(eval|print)(=|$)/.test(w),
  // perl 的 -e/-E 与组合形态（-pe/-ne/-lane）
  perl: (w) => /^-[a-zA-Z]*[eE]$/.test(w),
  // ruby 的 -e 与组合形态（-we）；-E 是外部编码带值，不以 e 结尾不误判
  ruby: (w) => /^-[a-zA-Z]*e$/.test(w),
  php: (w) => w === "-r" || w === "-R" || w === "-B" || w === "-E",
  lua: (w) => w === "-e",
};

/**
 * 解释器词的基线名：剥掉尾部版本号（python3、python3.12、ruby3.1、php8.2 → python/ruby/php）。
 * 版本化拼写与未列解释器同属脚本执行体，按基线名共用同一套一行流判定。
 */
function interpreterBase(word: string): string {
  return word.replace(/\d+(?:\.\d+)*$/, "");
}

/** 解释器词判定：含版本化拼写 */
function isInterpreterWord(word: string): boolean {
  return INTERPRETER_INLINE_FLAGS[interpreterBase(word)] !== undefined;
}

/** 脚本操作数：非选项词与 stdin 的「-」（重定向词如 2>&1、< f 除外） */
function isScriptOperand(word: string): boolean {
  return word === "-" || (!word.startsWith("-") && !/^\d*[<>]/.test(word));
}

/** xargs 的取值选项：其后一个 token 是其参数（引号剔除后参数可能已消失，见 xargs 分支） */
const XARGS_VALUE_FLAGS = new Set([
  "-I", "-n", "-L", "-s", "-P", "-a", "-d", "-E",
  "--replace", "--max-args", "--max-lines", "--max-chars", "--max-procs",
  "--arg-file", "--delimiter", "--eof", "--process-slot-var",
]);

/**
 * xargs 目标命令词的下标：跳过选项；取值选项连其参数一并跳过
 * （xargs -I {} rm 的 {} 是 -I 的值，不是目标）。
 * @param words xargs 之后的词
 * @returns 目标词下标；无目标返回 -1
 */
function xargsTargetIndex(words: string[]): number {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith("-")) {
      if (XARGS_VALUE_FLAGS.has(w)) i++;
      continue;
    }
    return i;
  }
  return -1;
}

/** xargs 目标词的写判定：目标为 shell/解释器时其脚本参数来自输入流，整体拒绝；
 *  其余目标按同一套段判定递归（xargs curl -o、xargs sort -o 同样命中） */
function xargsVerdict(words: string[], idx: number, shell: CommandShellKind): string | undefined {
  const target = normalizeCommandWord(words[idx]!);
  if (SCRIPT_HOST_WORDS.has(target) || isInterpreterWord(target)) return `写命令 xargs ${words[idx]}`;
  return segmentWriteVerdict(words.slice(idx), shell);
}

/** cmd if 的条件关键字：各带一个操作数（exist f、errorlevel 1、defined var） */
const CMD_IF_KEYWORDS = new Set(["exist", "defined", "errorlevel", "cmdextversion"]);

/** cmd if 的数值比较运算符（if 1 lss 2 cmd） */
const CMD_IF_COMPARE_OPS = new Set(["equ", "neq", "lss", "leq", "gtr", "geq"]);

/**
 * cmd 段是否为 if/for 语句（含 else 分支段与剥掉 do/else 关键字后的段）：
 * 只有这类段的括号是命令分组，其余位置是字面文本。
 * @param segment 命令段原文
 */
function isCmdIfForSegment(segment: string): boolean {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && /^(do|else)$/i.test(words[i]!)) i++;
  const head = normalizeCommandWord(words[i] ?? "");
  return head === "if" || head === "for";
}

/**
 * cmd 段首 if/for 的内层命令词表：for 取 do 之后的词，if 取条件之后的词。
 * if 的条件按可枚举形态跳过：/i 与 not 前缀、exist/defined/errorlevel/cmdextversion
 * 各带一个操作数、含 == 的比较式、两操作数夹一个比较运算符。
 * 段首不是 if/for 或条件不属于上述形态时原样返回（首词 if/for 不入黑名单，按只读放行）。
 * @param words 命令段分词
 * @returns 内层命令词表
 */
function cmdInlineCommand(words: string[]): string[] {
  let rest = words;
  // do 与 else 是关键字：for 的内层命令在 do 之后，if 各分组经 ;|& 切段后首词可能是 else
  while (rest.length > 0 && /^(do|else)$/i.test(rest[0]!)) rest = rest.slice(1);
  const head = normalizeCommandWord(rest[0] ?? "");
  if (head === "for") {
    const doIdx = rest.findIndex((w) => /^do$/i.test(w));
    return doIdx === -1 ? rest : rest.slice(doIdx + 1);
  }
  if (head !== "if") return rest;
  let i = 1;
  if (/^\/i$/i.test(rest[i] ?? "")) i++;
  if (/^not$/i.test(rest[i] ?? "")) i++;
  if (CMD_IF_KEYWORDS.has((rest[i] ?? "").toLowerCase())) i += 2;
  else if ((rest[i] ?? "").includes("==")) i += 1;
  else if (CMD_IF_COMPARE_OPS.has((rest[i + 1] ?? "").toLowerCase())) i += 3;
  else return rest;
  return rest.slice(i);
}

/**
 * 单个命令段的写判定：剥开段首包装与分组符号（与危险命令检查同口径，
 * 见 dangerous.ts stripCommandPrefix），按真实命令词查黑名单。
 * @param words 命令段分词（非空）
 * @param shell 命令实际执行方的 shell 语义（sc 的别名二义判定用）
 * @returns 违规原因；只读安全返回 undefined
 */
function segmentWriteVerdict(words: string[], shell: CommandShellKind): string | undefined {
  // cmd 的 if/for 段首看不出真实命令词，先剥包装（call/sudo/timeout 可能排在 if 之前）
  // 再取内层命令，内层命令自身也可能带包装，取完重新剥一遍（见 cmdInlineCommand）
  let { rest, queried } = stripCommandPrefix(words);
  // command -v/-V 只查询命令路径，不执行后续词
  if (queried) return undefined;
  if (shell === "cmd") {
    ({ rest, queried } = stripCommandPrefix(cmdInlineCommand(rest)));
    if (queried) return undefined;
  }
  const first = rest[0] === undefined ? undefined : normalizeCommandWord(rest[0]);
  if (!first) return undefined;
  // shell 家族与 Windows 脚本宿主：-c 内联、脚本文件、stdin 都是无法核验的内层代码，
  // 整体拒绝——与下面 cmd /c、powershell/pwsh 同口径（只读 agent 无正当需要）
  if (SCRIPT_HOST_WORDS.has(first)) {
    return `写命令 ${first}（脚本执行无法核验）`;
  }
  // 解释器脚本文件执行（python x.py、node x.js、deno run x.ts）：脚本内容同属无法核验的
  // 内层代码，拒绝。版本化拼写按基线名归一（python3.12 x.py）。
  // 一行流（-c/-e 等内联旗标）沿用既有边界：引号内代码与字面文本无法区分，不检测
  const interpreter = interpreterBase(first);
  const isInline = INTERPRETER_INLINE_FLAGS[interpreter];
  if (isInline) {
    // perl/ruby 的 -i 原地改写文件（含 -pi/-pie 组合与 -i.bak 后缀），先于一行流判定。
    // 只认小写旗标簇：-Mstrict、-Ilib 的带值选项词面含 i 但非 -i，不误拦
    if ((interpreter === "perl" || interpreter === "ruby") && rest.slice(1).some((w) => /^-[a-z]*i/.test(w))) {
      return `写命令 ${first} -i（原地改写）`;
    }
    if (!rest.slice(1).some(isInline) && rest.slice(1).some(isScriptOperand)) {
      return `写命令 ${first}（脚本文件执行无法核验）`;
    }
    return undefined;
  }
  // cmd /c /k 转交、PowerShell 与 WSL 调用、start 拉起新进程同理：内层命令（引号内的
  // -Command 脚本、base64 的 -EncodedCommand、WSL 内的 Linux 命令、start 的新窗口命令行）
  // 无法核验，整体拒绝。cmd 的 /c 可与命令粘连（cmd /cdel x），按前缀匹配。只读 agent 的
  // 读路径由内置工具与放行命令覆盖，无正当需要动用这些执行体；裸 cmd 不带 /c /k 不执行
  // 内层，不拦
  if (first === "cmd" && rest.some((w) => /^\/[ck]/i.test(w))) {
    return "写命令 cmd /c（内层命令无法核验）";
  }
  if (first === "powershell" || first === "pwsh" || first === "wsl" || first === "start") {
    return `写命令 ${first}（内层命令无法核验）`;
  }
  // sc 跨 shell 二义：PowerShell 5.1 里裸 sc 是 Set-Content 别名，按写拒绝；
  // sc.exe 拼写与 cmd/bash 语义下是 sc.exe 服务控制，读子命令白名单放行、其余拒绝。
  // 子命令前可带 \\server 形态（sc \\srv query svc），跳过服务器词再判
  if (first === "sc") {
    if (shell === "powershell" && !/\.exe$/i.test(rest[0]!)) return "写命令 sc（PowerShell 别名 Set-Content）";
    const sub = rest.slice(1).find((w) => !w.startsWith("\\"))?.toLowerCase();
    if (sub === undefined || sub === "/?" || SC_READ_SUBCOMMANDS.has(sub)) return undefined;
    return `写命令 sc ${sub}（服务控制写操作）`;
  }
  // xargs 的真实命令是首选项后的词。取值选项的参数可能仍在词表（-n 2），也可能被
  // 引号剔除后消失（-I '{}' rm 只剩 -I rm），词序按数量前移，单条线索定不准目标。
  // 多线索取并集，任一判写即拒绝：按取值跳过定位的目标、首个非选项词、每个取值选项
  // 的参数位之后的下一个非选项词（值消失时真目标落在这一位）。误拦面：取值恰为写命令
  // 词，或多个取值被引号剔除后目标的实参落在写命令词（如 xargs -I '{}' -d '\n' grep rm），
  // 形态罕见，按保守拒绝接受
  if (first === "xargs") {
    const tail = rest.slice(1);
    const candidates = new Set<number>();
    const plainIdx = tail.findIndex((w) => !w.startsWith("-"));
    if (plainIdx !== -1) candidates.add(plainIdx);
    const skipIdx = xargsTargetIndex(tail);
    if (skipIdx !== -1) candidates.add(skipIdx);
    for (let i = 0; i < tail.length; i++) {
      if (!(tail[i]!.startsWith("-") && XARGS_VALUE_FLAGS.has(tail[i]!))) continue;
      let v = i + 1;
      while (v < tail.length && tail[v]!.startsWith("-")) v++;
      let next = v + 1;
      while (next < tail.length && tail[next]!.startsWith("-")) next++;
      if (v < tail.length && next < tail.length) candidates.add(next);
    }
    for (const idx of [...candidates].sort((a, b) => a - b)) {
      const verdict = xargsVerdict(tail, idx, shell);
      if (verdict) return verdict;
    }
    return undefined;
  }
  if (PACKAGE_EXEC_WORDS.has(first)) return `写命令 ${first}（临时包执行无法核验）`;
  if (PACKAGE_MANAGER_WORDS.has(first)) {
    const args = rest.slice(1);
    // 裸「-」是 stdin 脚本（bun -），按操作数位取，不随选项一起跳过
    const sub = args.find((w) => w === "-" || !w.startsWith("-"))?.toLowerCase();
    // 裸 yarn 与只带非查询旗标的调用等于 yarn install（npm/pnpm/corepack 裸用只打印帮助）
    if (sub === undefined) {
      const onlyQueryFlag = args.length > 0 && args.every((w) => /^(-v|--version|-h|--help)$/.test(w));
      return first === "yarn" && !onlyQueryFlag ? "写命令 yarn（默认 install）" : undefined;
    }
    if (PKG_READ_SUBCOMMANDS.has(sub)) {
      // audit 的 fix 子形态改依赖树与锁文件，其余查询形态放行
      return sub === "audit" && args.some((w) => w === "fix" || w === "--fix")
        ? `写命令 ${first} audit fix（安装写依赖）`
        : undefined;
    }
    if (PKG_INSTALL_SUBCOMMANDS.has(sub)) return `写命令 ${first} ${sub}（安装写依赖）`;
    if (PKG_EXEC_SUBCOMMANDS.has(sub)) return `写命令 ${first} ${sub}（脚本执行无法核验）`;
    return `写命令 ${first} ${sub}（子命令无法核验）`;
  }
  // certutil 的编解码把结果写入文件（certutil -decode in.b64 out.bin）；-hashfile 等查询形态放行
  if (first === "certutil" && rest.slice(1).some((w) => /^[-/](encode|decode|decodehex)$/i.test(w))) {
    return "写命令 certutil（落盘写文件）";
  }
  if (WRITE_COMMAND_WORDS.has(first)) return `写命令 ${first}`;
  // 落盘与持久化形态（黑名单外按旗标/子命令判定）：
  // curl 裸用输出 stdout 是只读，但下列旗标把内容写入本地文件：-o/-O/--output/--remote-name
  // （含 -so 组合与 -oFILE 粘连）、-D/--dump-header、-c/--cookie-jar、--stderr、--trace(-ascii)、
  // --etag-save、--libcurl、--alt-svc、--hsts；iwr/irm 的 -OutFile（含 PowerShell 前缀缩写 -OutF）同理
  if (first === "curl" &&
      rest.slice(1).some((w) =>
        /^-[A-Za-z]*[oODc]/.test(w) ||
        /^--(output|remote-name(-all)?|dump-header|cookie-jar|stderr|trace|trace-ascii|etag-save|libcurl|alt-svc|hsts)(=|$)/.test(w))) {
    return "写命令 curl（落盘写文件）";
  }
  if ((first === "iwr" || first === "invoke-webrequest" || first === "irm" || first === "invoke-restmethod") &&
      rest.slice(1).some((w) => /^-(outf|outfi|outfil|outfile)(=|:|$)/i.test(w))) {
    return `写命令 ${first}（落盘写文件）`;
  }
  // sort 输出写文件：cmd 的 /o、POSIX 的 -o/--output（无该选项输出 stdout 是只读）。
  // /o 按整词匹配，不误伤以 /o 开头的路径操作数（sort /opt/data.txt），与 bash.ts 同口径
  if (first === "sort" && rest.slice(1).some((w) => /^\/o$/i.test(w) || /^-[A-Za-z]*o/.test(w) || /^--output(=|$)/.test(w))) {
    return "写命令 sort（输出写文件）";
  }
  if (first === "reg") {
    const sub = rest[1]?.toLowerCase();
    return sub !== undefined && REG_WRITE_SUBCOMMANDS.has(sub) ? `写命令 reg ${sub}` : undefined;
  }
  if (first === "schtasks" && rest.slice(1).some((w) => SCHTASKS_WRITE_FLAGS.has(w.toLowerCase()))) {
    return "写命令 schtasks（改计划任务）";
  }
  // awk/sed 的 -f/--file：程序来自脚本文件，同 python x.py 类，无法核验一律拒绝（awk 的 -F 字段分隔符不匹配）
  if ((first === "awk" || first === "gawk" || first === "mawk" || first === "sed") &&
      rest.slice(1).some((w) => /^-f/.test(w) || /^--file(=|$)/.test(w))) {
    return `写命令 ${first} -f（脚本文件执行无法核验）`;
  }
  // find 的写动作：-delete 与 -exec/-ok 系列执行任意命令，均为写操作
  if (first === "find" && /-(delete|exec|execdir|okdir|ok|fprint|fprintf|fprint0|fls)\b/.test(rest.join(" "))) {
    return "写命令 find（删除/执行/输出到文件）";
  }
  // sed 大小写旗标一并认：GNU 的 -E/-i 与组合（-Ei/-ni），BSD/macOS 的 -I 系列同为
  // 原地改写（GNU 下 -I 非法不落盘，放宽无代价）；perl/ruby 因 -M/-I 带值只认小写簇
  if (first === "sed" && rest.some((w) => /^-[a-z]*i/i.test(w) || /^--in-place(=|$)/.test(w))) {
    return "写命令 sed -i（原地改写）";
  }
  // attrib / icacls 的显示形态是查询；带属性/ACL 修改旗标时改文件元数据或落盘（/save），按写拒绝
  if (first === "attrib" && rest.some((w) => /^[+-][a-z]+$/i.test(w))) {
    return "写命令 attrib（改文件属性）";
  }
  if (first === "icacls" && rest.some((w) => /^\/(grant|deny|remove|reset|inherit|save|restore|setowner|substitute)/i.test(w))) {
    return "写命令 icacls（改文件 ACL）";
  }
  if (first === "git") {
    return gitWriteVerdict(rest);
  }
  return undefined;
}

/** git branch/tag 的查询选项（命中即视为查询形态，不按裸参数判写） */
const GIT_QUERY_FLAGS = new Set([
  "-l", "--list", "-a", "-r", "-v", "--show-current", "--contains", "--no-contains",
  "--merged", "--no-merged", "--points-at", "--sort", "--format", "--column", "--color",
]);

/** git branch/tag 的写选项（与查询混用时仍按写拒绝，如 -d -v） */
const GIT_WRITE_FLAG_RE = /^(-[dDmMcCsuF]|--delete|--move|--edit-description|--set-upstream|--unset-upstream)/;

/** git config 的写旗标：改值、删值、改段与开编辑器，命中即写 */
const GIT_CONFIG_WRITE_FLAGS = new Set([
  "-e", "--edit", "--add", "--unset", "--unset-all", "--replace-all", "--remove-section", "--rename-section",
]);

/** git config 的取值旗标：其后一个词是旗标参数，不是操作数（-f file <name> 的 file） */
const GIT_CONFIG_VALUE_FLAGS = new Set(["-f", "--file", "--blob", "--default", "--comment", "-t", "--type"]);

/**
 * git config 的操作数个数：跳过旗标，取值旗标连其参数一并跳过。
 * @param words config 之后的词
 * @returns 非旗标操作数个数
 */
function gitConfigOperandCount(words: string[]): number {
  let count = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith("-")) {
      if (GIT_CONFIG_VALUE_FLAGS.has(w)) i++;
      continue;
    }
    count++;
  }
  return count;
}

/**
 * git 子命令写判定：变更子命令直接拒绝；branch/tag/worktree/stash/config/remote/submodule/reflog
 * 区分查询形态，其余写子命令命中即拒绝。
 * @param words 以 git 开头的命令段分词
 * @returns 违规原因；只读安全返回 undefined
 */
function gitWriteVerdict(words: string[]): string | undefined {
  const sub = words[1];
  if (!sub) return undefined;
  if (!GIT_WRITE_SUBCOMMANDS.has(sub)) return undefined;
  const rest = words.slice(2);
  if (sub === "worktree") {
    // 仅 list 是查询；add/remove/move/prune/lock 均改仓库
    return rest[0] === "list" ? undefined : "写命令 git worktree";
  }
  if (sub === "branch" || sub === "tag") {
    const hasWriteFlag = rest.some((w) => GIT_WRITE_FLAG_RE.test(w));
    const hasQueryFlag = rest.some((w) => GIT_QUERY_FLAGS.has(w.split("=")[0]!));
    const hasOperand = rest.some((w) => !w.startsWith("-"));
    if (hasWriteFlag || (hasOperand && !hasQueryFlag)) return `写命令 git ${sub}`;
    return undefined;
  }
  if (sub === "stash") {
    // 仅 list/show 是查询，其余用法（存取、清空）是写
    const mode = rest[0];
    return mode === undefined || (mode !== "list" && mode !== "show") ? "写命令 git stash" : undefined;
  }
  if (sub === "config") {
    // 写形态：写旗标（--add/--unset*/--replace-all/--remove-section/--rename-section/-e/--edit）命中，
    // 或操作数多于一个（git config <name> <value> 写值）。
    // 读形态：git config（列全部）、git config <name>（查值）与 --get*/--list/-l；
    // 取值旗标的参数不计操作数（-f cfg <name>）
    if (rest.some((w) => GIT_CONFIG_WRITE_FLAGS.has(w))) return "写命令 git config";
    return gitConfigOperandCount(rest) > 1 ? "写命令 git config" : undefined;
  }
  if (sub === "remote") {
    // 查询：无参数（列出远程名）、-v/--verbose（显示 URL 列表）、show、get-url；
    // add/remove/rename/set-url/prune/update 等改配置
    const mode = rest[0];
    const isQuery = mode === undefined || mode === "-v" || mode === "--verbose" || mode === "show" || mode === "get-url";
    return isQuery ? undefined : "写命令 git remote";
  }
  if (sub === "submodule") {
    // 查询：无参数（列出子模块）、status；add/init/update/deinit/sync 等改仓库
    const mode = rest[0];
    return mode === undefined || mode === "status" ? undefined : "写命令 git submodule";
  }
  if (sub === "reflog") {
    // 查询：无参数（默认 show）与 show；delete/expire 改写 reflog
    const mode = rest[0];
    return mode === undefined || mode === "show" ? undefined : "写命令 git reflog";
  }
  return `写命令 git ${sub}`;
}

/** git 变更子命令：git <sub> 命中即写操作（branch/tag/worktree/stash/config/remote/submodule/reflog
 *  有查询豁免，见 gitWriteVerdict） */
const GIT_WRITE_SUBCOMMANDS = new Set([
  "add", "commit", "push", "pull", "merge", "rebase", "reset", "restore",
  "checkout", "switch", "clean", "cherry-pick", "revert", "apply", "am",
  "rm", "mv", "stash", "branch", "tag", "worktree",
  // 配置、仓库与引用变更：config/remote 改配置、init 建仓库、fetch/submodule 拉取落盘、
  // update-ref 改写引用、gc 与 reflog 重写仓库数据
  "config", "init", "remote", "fetch", "submodule", "update-ref", "gc", "reflog",
]);

/**
 * bash 写命令黑名单：命令词命中即写操作（按命令段首词匹配，不做全文词搜索）。
 * POSIX 词与 Windows 词（cmd 内建 + PowerShell 常用别名/cmdlet）合并为一套，不分 shell
 * 生效：Windows 词在 POSIX 下无对应可执行文件，拦了也只是保守；POSIX 词在 Windows 下
 * 经 Git 工具链照常可执行。匹配统一取小写（Windows 可执行名查找不分大小写）。
 * PowerShell 的 type（Get-Content 别名）与 cmd 的 type（显示文件内容）均为只读，不入表；
 * where 同为查询。命令词可被 doskey 宏与 Set-Alias 改名绕过，见文件头边界说明。
 */
const WRITE_COMMAND_WORDS = new Set([
  // POSIX：删除、移动、复制、链接、目录、权限与原地写
  "rm", "rmdir", "mv", "cp", "ln", "mkdir", "touch", "chmod", "chown", "chgrp",
  "dd", "tee", "truncate", "shred", "mkfifo", "install", "patch",
  // cmd 内建与随附工具：del/erase、ren/rename、rd/md 与 mkdir/rmdir 互为同义词；
  // xcopy/robocopy 是 copy 的递归形态；mklink 建链接；takeown 无纯显示形态；
  // setx 写用户级环境变量（持久化）
  "del", "erase", "copy", "xcopy", "robocopy", "move", "ren", "rename",
  "rd", "md", "mklink", "format", "takeown", "setx",
  // PowerShell 写类 cmdlet 与标准别名（rm/del/erase/rd/copy/move/mv/cp/mkdir/tee 等
  // 别名已被上面词覆盖）。sc 按 shell 语义单独判定、curl 按输出旗标判定，见
  // segmentWriteVerdict 对应分支，不入表
  "remove-item", "copy-item", "move-item", "new-item", "set-content", "add-content",
  "clear-content", "out-file", "set-itemproperty", "export-csv", "export-clixml", "set-acl",
  "ri", "ni", "cpi", "mi", "ac", "clc", "sp",
  // 下载落盘：wget 默认写文件（输出到 stdout 的 -O - 形态罕见，只读取内容用 curl 即可，保守整体拒绝）
  "wget",
]);
