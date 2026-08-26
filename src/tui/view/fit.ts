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
