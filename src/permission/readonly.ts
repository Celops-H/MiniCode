/**
 * 只读 agent 的写操作判定（轻量）：工具元数据 + bash 写命令模式。
 * 用于只读派生子 agent（spawn_agent 只读声明）的工具执行前拦截。
 * 与危险命令检查同为轻量守卫，不做完整 shell 解析，已知边界：
 * - awk/perl/python -c 等一行流脚本引号内的写行为不检测（引号段剔除是为
 *   「echo "rm" 不误拦」服务的，一行流里的真实代码无法与字面文本区分）；
 * - $( ) 命令替换内的写命令不检测，由权限管线的危险命令检查兜底
 *   （该检查随管线存在，无管线的 agent 无此兜底）。
 */
import { stripQuotedSpans } from "./dangerous.js";

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
 * @returns 违规原因（允许执行返回 undefined）
 */
export function readOnlyToolViolation(
  toolName: string,
  toolIsReadOnly: boolean | undefined,
  command?: string,
): string | undefined {
  // bash 单独走命令级判定（只读命令可用，写命令拒绝）
  if (toolName === "bash") return command === undefined ? undefined : bashWriteViolation(command);
  if (toolIsReadOnly === true) return undefined;
  if (STATE_TOOL_ALLOW.has(toolName)) return undefined;
  return toolIsReadOnly === false ? `工具 ${toolName} 具有写副作用` : `工具 ${toolName} 副作用未知`;
}

/**
 * 判定 bash 命令是否为写命令：重定向（/dev/null 除外）或命令段命中写命令黑名单。
 * 按 ; | & 换行切段逐段判定，管道右侧的 tee、xargs 后的写命令同样命中；
 * 引号内字面文本剔除后匹配（echo "rm" 不误拦）。
 * @param command 命令原文
 * @returns 违规原因；只读安全返回 undefined
 */
function bashWriteViolation(command: string): string | undefined {
  let stripped = stripQuotedSpans(command);
  // 丢弃输出的重定向不是写（cmd 2>/dev/null），先摘除再判定，防高频安全用法误拦
  stripped = stripped.replace(/>{1,2}\s*\/dev\/null\b/g, " ");
  // 重定向到文件：> >> 2> &> 等（>&2 / 2>&1 是 fd 复制不写文件；
  // >( 进程替换由危险命令检查拦截——该检查挂在权限管线，管线缺失时不兜底）
  if (/>{1,2}(?!&\d)(?!\()/.test(stripped)) return "命令含重定向写文件";
  for (const segment of stripped.split(/[|;&\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    const verdict = segmentWriteVerdict(words);
    if (verdict) return verdict;
  }
  return undefined;
}

/** 前缀命令的取值选项：其后一个 token 是该选项的参数，随选项一并跳过 */
const PREFIX_VALUE_FLAGS = new Set([
  "-u", "-g", "-C", "-p", "-T", "-D", "-R", "-S", "-w", "-f", "-n",
  "--user", "--group", "--unset", "--split-string",
]);

/**
 * 单个命令段的写判定：跳过变量赋值前缀与 sudo/env/nohup 等包装命令
 * （含其选项与选项参数），按真实命令词查黑名单。
 * @param words 命令段分词（非空）
 * @returns 违规原因；只读安全返回 undefined
 */
function segmentWriteVerdict(words: string[]): string | undefined {
  let rest = [...words];
  // 外层循环：连乘的包装（sudo env FOO=1 cmd）逐层剥开
  while (rest.length > 0) {
    const head = rest[0]!;
    const isWrapper =
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(head) ||
      head === "sudo" || head === "env" || head === "nohup" || head === "nice" ||
      head === "stdbuf" || head === "timeout" || head === "command";
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
  const first = rest[0];
  if (!first) return undefined;
  // sh -c 内层命令在引号里无法核验，整体按不可核验拒绝（只读 agent 无正当需要）
  if ((first === "sh" || first === "bash" || first === "dash" || first === "zsh") && rest.includes("-c")) {
    return `写命令 ${first} -c（内层命令无法核验）`;
  }
  // xargs 的真实命令是首选项后的词
  if (first === "xargs") {
    const target = rest.slice(1).find((w) => !w.startsWith("-"));
    if (target && WRITE_COMMAND_WORDS.has(target)) return `写命令 xargs ${target}`;
    return undefined;
  }
  if (WRITE_COMMAND_WORDS.has(first)) return `写命令 ${first}`;
  // find 的写动作：-delete 与 -exec/-ok 系列执行任意命令，均为写操作
  if (first === "find" && /-(delete|exec|execdir|okdir|ok|fprint|fprintf|fprint0|fls)\b/.test(rest.join(" "))) {
    return "写命令 find（删除/执行/输出到文件）";
  }
  if (first === "sed" && rest.some((w) => w === "-i" || w === "--in-place")) {
    return "写命令 sed -i（原地改写）";
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

/** bash 写命令黑名单：命令词命中即写操作（按命令段首词匹配，不做全文词搜索） */
const WRITE_COMMAND_WORDS = new Set([
  "rm", "rmdir", "mv", "cp", "ln", "mkdir", "touch", "chmod", "chown", "chgrp",
  "dd", "tee", "truncate", "shred", "mkfifo", "install", "patch",
]);
