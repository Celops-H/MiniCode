/**
 * 只读 agent 的写操作判定（轻量）：工具元数据 + bash 写命令模式。
 * 用于只读派生子 agent（spawn_agent 只读声明）的工具执行前拦截。
 * 与危险命令检查同为轻量守卫，不做完整 shell 解析，已知边界：
 * - awk/perl/python -c 等一行流脚本引号内的写行为不检测（引号段剔除是为
 *   「echo "rm" 不误拦」服务的，一行流里的真实代码无法与字面文本区分）；
 *   同源边界：引号包住的命令词、脚本路径与旗标也随引号段剔除而逃过判定
 *   （"bash x.sh" 整串、"C:\...\bash.exe" -c、python "x.py"、curl "-o"）；
 * - $( ) 命令替换内的写命令不检测，由权限管线的危险命令检查兜底
 *   （该检查随管线存在，无管线的 agent 无此兜底）。兜底按实际 shell 语义生效：
 *   cmd 归类下 bash -c 引号内的替换不被危险命令检查拦，只读侧由 shell 执行体
 *   整体拒绝兜住，root 侧该形态落入正常审批链；
 * - cmd 的 doskey 宏与 PowerShell 的 Set-Alias 可把写命令改名（如 sal wd Remove-Item），
 *   改名后的命令词绕过黑名单，不做别名反解；
 * - 写命令黑名单按命令词枚举守卫，跨 shell 语义归并（见 WRITE_COMMAND_WORDS 注释）；
 *   脚本执行（shell 家族、cscript/wscript、解释器脚本文件与 awk/sed -f）整体拒绝，
 *   落盘出口（下载、sort 输出文件）与持久化写（注册表、setx、计划任务、服务控制）
 *   按形态判定，见 segmentWriteVerdict 各分支；
 * - 包管理器安装与脚本执行（pnpm install 等）、for 循环 do 内嵌命令、certutil -decode
 *   等其余执行与落盘形态未覆盖（缺口记录 request.md E190）。
 */
import { resolveCommandShell, stripQuotedSpans, type CommandShellKind } from "./dangerous.js";

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
  let stripped = stripQuotedSpans(command);
  // 丢弃输出的重定向不是写（cmd 2>/dev/null、cmd 2>nul），先摘除再判定，防高频安全用法误拦
  // nul 不认扩展名形态（nul.txt 在 NT 上是普通文件）；nul: 带冒号的设备写法一并豁免
  stripped = stripped.replace(/>{1,2}\s*\/dev\/null\b/g, " ");
  if (shell !== "bash") stripped = stripped.replace(/>{1,2}\s*nul(?![.\w])/gi, " ");
  // 重定向到文件：> >> 2> &> 等（>&2 / 2>&1 是 fd 复制不写文件；
  // >( 进程替换由危险命令检查拦截——该检查挂在权限管线，管线缺失时不兜底）
  if (/>{1,2}(?!&\d)(?!\()/.test(stripped)) return "命令含重定向写文件";
  for (const segment of stripped.split(/[|;&\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    const verdict = segmentWriteVerdict(words, shell);
    if (verdict) return verdict;
  }
  return undefined;
}

/** 前缀命令的取值选项：其后一个 token 是该选项的参数，随选项一并跳过 */
const PREFIX_VALUE_FLAGS = new Set([
  "-u", "-g", "-C", "-p", "-T", "-D", "-R", "-S", "-w", "-f", "-n",
  "--user", "--group", "--unset", "--split-string",
]);

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

/** 脚本解释器与各自的一行流旗标判定：旗标含义随解释器不同（python 的 -E 是忽略环境
 *  变量，perl 的 -E 才是内联执行），按命令词分设；命中一行流即放行，否则出现脚本操作数即拒绝 */
const INTERPRETER_INLINE_FLAGS: Record<string, (word: string) => boolean> = {
  // python 内联只有 -c（-m 执行模块、-E/-B 均非内联，带脚本操作数按文件执行拦）
  python: (w) => w === "-c",
  python3: (w) => w === "-c",
  py: (w) => w === "-c",
  node: (w) => w === "-e" || w === "-p" || /^--(eval|print)(=|$)/.test(w),
  // perl 的 -e/-E 与组合形态（-pe/-ne/-lane）
  perl: (w) => /^-[a-zA-Z]*[eE]$/.test(w),
  // ruby 的 -e 与组合形态（-we）；-E 是外部编码带值，不以 e 结尾不误判
  ruby: (w) => /^-[a-zA-Z]*e$/.test(w),
  php: (w) => w === "-r" || w === "-R" || w === "-B" || w === "-E",
  lua: (w) => w === "-e",
};
const INTERPRETER_WORDS = new Set(Object.keys(INTERPRETER_INLINE_FLAGS));

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
  if (SCRIPT_HOST_WORDS.has(target) || INTERPRETER_WORDS.has(target)) return `写命令 xargs ${words[idx]}`;
  return segmentWriteVerdict(words.slice(idx), shell);
}

/**
 * 命令词归一：取路径基名、剥首尾分组符号与 cmd 的 @ 静默前缀、剥 Windows 可执行后缀、转小写。
 * Windows 的可执行名查找不分大小写与分隔符（cmd.exe / C:\...\cmd.exe 与 cmd 等效），
 * 统一归一后比较，防拼写变体绕过（@del、括号包住的首词同为常见拼写形态）；
 * POSIX 下多余的大写形态本就不存在，按写拦不误伤。
 */
function normalizeCommandWord(word: string): string {
  const base = word.split(/[\\/]/).pop()!;
  const cleaned = base.replace(/^[@({]+/, "").replace(/[)}]+$/, "");
  return cleaned.replace(/\.(exe|com|cmd|bat)$/i, "").toLowerCase();
}

/**
 * 单个命令段的写判定：跳过变量赋值前缀与 sudo/env/nohup 等包装命令
 * （含其选项与选项参数），按真实命令词查黑名单。
 * @param words 命令段分词（非空）
 * @param shell 命令实际执行方的 shell 语义（sc 的别名二义判定用）
 * @returns 违规原因；只读安全返回 undefined
 */
function segmentWriteVerdict(words: string[], shell: CommandShellKind): string | undefined {
  let rest = [...words];
  // 外层循环：连乘的包装（sudo env FOO=1 cmd）逐层剥开
  while (rest.length > 0) {
    // 段首的独立分组符号词逐层剥干净（( rm x)、{ rm x、@ del x——含剥包装后露出的
    // call ( del x），首词判定看其后真实命令词
    while (rest.length > 0 && /^[@({]+$/.test(rest[0]!)) rest.shift();
    if (rest.length === 0) break;
    const head = normalizeCommandWord(rest[0]!);
    // command 的旗标只有 -p/-v/-V（可组合，如 -pv）：带 -v/-V 是查询命令路径，不执行
    // 后续词，整体放行；只有 -p 时剥掉 command 与其旗标（-p 用默认 PATH 执行后续命令），
    // 按后续命令词继续判定。单列处理避免共享取值旗标表把 -v 当成 -p 的参数吞掉
    if (head === "command") {
      let i = 1;
      let queried = false;
      while (i < rest.length && /^-[pvV]+$/.test(rest[i]!)) {
        if (/[vV]/.test(rest[i]!)) queried = true;
        i++;
      }
      if (queried) return undefined;
      rest.splice(0, i);
      continue;
    }
    const isWrapper =
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(head) ||
      head === "sudo" || head === "env" || head === "nohup" || head === "nice" ||
      head === "stdbuf" || head === "timeout" || head === "call";
    if (!isWrapper) break;
    rest.shift();
    // timeout 的首参数是时长（timeout 10 rm x），随包装一并剥掉
    if (head === "timeout" && /^\d+[smhd]?$/.test(rest[0] ?? "")) rest.shift();
    // 剥包装后继续吞选项与赋值；取值选项连参数一起吞
    while (rest.length > 0) {
      const word = rest[0]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
        rest.shift();
      } else if (word.startsWith("-")) {
        rest.shift();
        if (PREFIX_VALUE_FLAGS.has(word)) rest.shift();
      } else {
        break;
      }
    }
  }
  const first = rest[0] === undefined ? undefined : normalizeCommandWord(rest[0]);
  if (!first) return undefined;
  // shell 家族与 Windows 脚本宿主：-c 内联、脚本文件、stdin 都是无法核验的内层代码，
  // 整体拒绝——与下面 cmd /c、powershell/pwsh 同口径（只读 agent 无正当需要）
  if (SCRIPT_HOST_WORDS.has(first)) {
    return `写命令 ${first}（脚本执行无法核验）`;
  }
  // 解释器脚本文件执行（python x.py、node x.js）：脚本内容同属无法核验的内层代码，拒绝。
  // 一行流（-c/-e 等内联旗标）沿用既有边界：引号内代码与字面文本无法区分，不检测
  if (INTERPRETER_WORDS.has(first)) {
    // perl/ruby 的 -i 原地改写文件（含 -pi/-pie 组合与 -i.bak 后缀），先于一行流判定。
    // 只认小写旗标簇：-Mstrict、-Ilib 的带值选项词面含 i 但非 -i，不误拦
    if ((first === "perl" || first === "ruby") && rest.slice(1).some((w) => /^-[a-z]*i/.test(w))) {
      return `写命令 ${first} -i（原地改写）`;
    }
    const isInline = INTERPRETER_INLINE_FLAGS[first]!;
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
  // 引号剔除后消失（-I '{}' rm 只剩 -I rm），两条线索都取：按取值跳过定位的目标、
  // 首个非选项词，任一判写即拒绝
  if (first === "xargs") {
    const tail = rest.slice(1);
    const skipIdx = xargsTargetIndex(tail);
    if (skipIdx !== -1) {
      const verdict = xargsVerdict(tail, skipIdx, shell);
      if (verdict) return verdict;
    }
    const plainIdx = tail.findIndex((w) => !w.startsWith("-"));
    if (plainIdx === -1 || plainIdx === skipIdx) return undefined;
    return xargsVerdict(tail, plainIdx, shell);
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
  // sort 输出写文件：cmd 的 /o、POSIX 的 -o/--output（无该选项输出 stdout 是只读）
  if (first === "sort" && rest.slice(1).some((w) => /^\/o/i.test(w) || /^-[A-Za-z]*o/.test(w) || /^--output(=|$)/.test(w))) {
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
  if (first === "sed" && rest.some((w) => /^-[a-z]*i/.test(w) || /^--in-place(=|$)/.test(w))) {
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

/**
 * git 子命令写判定：变更子命令直接拒绝；branch/tag/worktree 区分查询形态。
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
  return `写命令 git ${sub}`;
}

/** git 变更子命令：git <sub> 命中即写操作（branch/tag/worktree/stash 有查询豁免，见 gitWriteVerdict） */
const GIT_WRITE_SUBCOMMANDS = new Set([
  "add", "commit", "push", "pull", "merge", "rebase", "reset", "restore",
  "checkout", "switch", "clean", "cherry-pick", "revert", "apply", "am",
  "rm", "mv", "stash", "branch", "tag", "worktree",
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
