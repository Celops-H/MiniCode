/**
 * shell 命令分词的公共纯函数：命令词归一、段首包装剥离、uniq 操作数落盘判定。
 * 不含权限语义，src/tools 与 src/permission 共用，避免工具代码反向依赖权限模块。
 */

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
 * 与危险命令检查、只读守卫共用同一口径，防连乘包装（sudo env FOO=1 cmd）绕过首词判定。
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
    // timeout 的时长排在选项之后（timeout 10 rm x、timeout -k 5 0.5 rm x），吞完选项再剥一次；
    // 时长按 GNU timeout 的 strtod 取值口径认数值形态，含前导小数点与指数写法
    // （timeout 0.5 rm x、timeout .5 rm x、timeout 1e3 rm x），后缀 s/m/h/d 保留
    if (head === "timeout" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[smhd]?$/.test(rest[0] ?? "")) rest.shift();
  }
  return { rest, queried: false };
}

/** uniq 的取值旗标：其后一个词是旗标参数，不是文件操作数 */
const UNIQ_VALUE_FLAGS = new Set(["-f", "--skip-fields", "-s", "--skip-chars", "-w", "--check-chars"]);

/**
 * uniq 的输出位有文件操作数即落盘（uniq in.txt out.txt）。
 * 「-」作输入是 stdin、作输出是 stdout，输出位是「-」不算落盘。
 * 取值旗标连其参数一并跳过；-- 之后的词全按操作数算。
 * 边界：取值旗标的参数被引号包住时随引号段剔除消失，其后的真操作数被当参数吞掉
 * （uniq -f "1" in.txt out.txt 判无输出），与包装命令同一根因。
 * @param words uniq 之后的词
 * @returns 是否把结果写入文件
 */
export function uniqWritesToFile(words: string[]): boolean {
  const operands: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--") {
      operands.push(...words.slice(i + 1));
      break;
    }
    if (w.startsWith("-") && w !== "-") {
      if (UNIQ_VALUE_FLAGS.has(w)) i++;
      continue;
    }
    operands.push(w);
  }
  return operands.length > 1 && operands[1] !== "-";
}
