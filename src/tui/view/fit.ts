/** 终端展示列宽：东亚全宽/全角字符与 emoji 计 2 列，其余 1 列（G-7 补 emoji 扩展区；
 *  CJK 按码点截断会溢出折行，见 Modal/StatusBar 使用处） */
export function colWidth(s: string): number {
  let w = 0;
  for (const ch of Array.from(s)) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}]/u.test(ch) ? 2 : 1;
  return w;
}

/** 按列宽截断：末尾省略号占 1 列；预算 ≤1 列时只剩省略号 */
export function fitWidth(t: string, maxCols: number): string {
  if (colWidth(t) <= maxCols) return t;
  if (maxCols <= 1) return "…";
  const chars = Array.from(t);
  let out = "";
  let w = 0;
  for (const ch of chars) {
    const cw = colWidth(ch);
    if (w + cw + 1 > maxCols) break; // 留 1 列给省略号
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** 右侧空格补齐到目标列宽（CJK 计 2 列）：会话列表三列各自对齐（P4-3） */
export function padCols(s: string, cols: number): string {
  const w = colWidth(s);
  return w >= cols ? s : s + " ".repeat(cols - w);
}

/** 相对时间（P4-3 副行）：xx s/min/hour(s)/day(s) ago（G-7 单复数：1 hour 不加 s） */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(hr / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/** 文件大小展示：B/KB/MB 分级（G-2=40，>1KB 显示 KB、>1MB 显示 MB，不再大数字难读） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}
