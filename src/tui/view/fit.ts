/** 终端展示列宽：东亚全宽/全角字符计 2 列，其余 1 列（CJK 按码点截断会溢出折行，见 Modal/StatusBar 使用处） */
export function colWidth(s: string): number {
  let w = 0;
  for (const ch of Array.from(s)) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
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

/** 相对时间（P4-3 副行）：xx s/min/hours/days ago（用户指定格式） */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}hours ago`;
  return `${Math.floor(hr / 24)}days ago`;
}

/** 文件大小展示：KB 一位小数，不足 1KB 显示 B */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
