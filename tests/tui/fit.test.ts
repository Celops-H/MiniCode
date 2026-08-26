/**
 * 层 1：fit.ts 列宽/截断纯函数单测——CJK 全宽字符占 2 列、截断留省略号（按列宽非码点，
 * 按码点截中文会溢出折行，见 P1-3 修过的折行缺陷）。
 */
import { it, expect } from "vitest";
import { colWidth, fitWidth, padCols, relativeTime, formatBytes } from "../../src/tui/view/fit.js";

it("colWidth：ASCII 1 列、CJK 全宽 2 列、emoji 2 列（G-7）、混合", () => {
  expect(colWidth("ab")).toBe(2);
  expect(colWidth("中文")).toBe(4);
  expect(colWidth("a中b")).toBe(4);
  expect(colWidth("")).toBe(0);
  expect(colWidth("🎉")).toBe(2); // emoji 扩展区 2 列
  expect(colWidth("a🎉")).toBe(3);
});

it("fitWidth：不超预算原样返回", () => {
  expect(fitWidth("ab", 2)).toBe("ab");
  expect(fitWidth("中文", 4)).toBe("中文");
});

it("fitWidth：超预算按列宽截断末尾加省略号（留 1 列给省略号）", () => {
  expect(fitWidth("中文标题", 6)).toBe("中文…"); // 4 列内容 + 1 列省略号，再加一汉字超预算
  expect(fitWidth("abcde", 4)).toBe("abc…");
  expect(fitWidth("ab", 1)).toBe("…"); // 预算 ≤1 列只剩省略号
});

it("fitWidth：CJK 截断按列宽（预算 3 列只放得下 1 个汉字 + 省略号）", () => {
  expect(fitWidth("中文标题", 3)).toBe("中…");
});

it("padCols：右补空格到目标列宽（CJK 计 2 列），超宽原样返回", () => {
  expect(padCols("ab", 5)).toBe("ab   ");
  expect(padCols("中文", 5)).toBe("中文 "); // 4 列 + 1 空格
  expect(padCols("abcdef", 3)).toBe("abcdef");
});

it("relativeTime：s/min/hour(s)/day(s) ago 四档（G-7 单复数：1 不加 s）", () => {
  const now = Date.parse("2026-08-27T12:00:00.000Z");
  expect(relativeTime("2026-08-27T11:59:40.000Z", now)).toBe("20s ago");
  expect(relativeTime("2026-08-27T11:30:00.000Z", now)).toBe("30min ago");
  expect(relativeTime("2026-08-27T06:00:00.000Z", now)).toBe("6 hours ago");
  expect(relativeTime("2026-08-24T00:00:00.000Z", now)).toBe("3 days ago");
  expect(relativeTime("2026-08-27T11:00:00.000Z", now)).toBe("1 hour ago"); // 单数不加 s
  // 非法时间不抛错
  expect(relativeTime("not-a-date", now)).toBe("—");
});

it("formatBytes：B/KB/MB 分级（G-2，>1MB 显示 MB 不再大数字难读）", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(4096)).toBe("4.0 KB");
  expect(formatBytes(2048 * 1024)).toBe("2.00 MB");
});
