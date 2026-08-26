/**
 * 层 1：fit.ts 列宽/截断纯函数单测——CJK 全宽字符占 2 列、截断留省略号（按列宽非码点，
 * 按码点截中文会溢出折行，见 P1-3 修过的折行缺陷）。
 */
import { it, expect } from "vitest";
import { colWidth, fitWidth } from "../../src/tui/view/fit.js";

it("colWidth：ASCII 1 列、CJK 全宽 2 列、混合", () => {
  expect(colWidth("ab")).toBe(2);
  expect(colWidth("中文")).toBe(4);
  expect(colWidth("a中b")).toBe(4);
  expect(colWidth("")).toBe(0);
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
