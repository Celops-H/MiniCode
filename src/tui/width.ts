/**
 * 展示宽度工具（从旧渲染层 render.ts 搬迁，纯函数）：终端显示按格子计，CJK/emoji 等宽字符占 2 格。
 * 输入框光标列定位、文本截断共用。
 */

/** 半角宽字符区间（CJK 全角、假名、emoji 等按 2 格计）。处理 emoji ZWJ 组合时误差可接受。 */
const WIDE_CODEPOINTS: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

/** 单个字符的展示宽度（半角 1，宽字符 2） */
export function charWidth(char: string): number {
  const code = char.codePointAt(0)!;
  for (const [lo, hi] of WIDE_CODEPOINTS) {
    if (code >= lo && code <= hi) return 2;
  }
  return 1;
}

/** 文本的展示宽度（按显示列数计，宽字符按 2） */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

/** 按展示宽度截断文本：不切进一个宽字符中间 */
export function truncateWidth(text: string, maxWidth: number): string {
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = charWidth(ch);
    if (width + w > maxWidth) break;
    out += ch;
    width += w;
  }
  return out;
}