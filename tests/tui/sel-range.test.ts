/**
 * 输入框选区渲染边界（审查 M-2）：lineSelRange 纯函数——单行/跨行/反向/空选区/行边界。
 */
import { describe, expect, it } from "vitest";
import { lineSelRange } from "../../src/tui/view/Prompt.js";

describe("lineSelRange（选区行内区间）", () => {
  it("同行正向：锚点在前、光标在后", () => {
    expect(lineSelRange(6, 0, { line: 0, col: 1 }, 0, 4)).toEqual([1, 4]);
  });
  it("同行反向：光标在前、锚点在后（归一化到锚点前）", () => {
    expect(lineSelRange(6, 0, { line: 0, col: 4 }, 0, 1)).toEqual([1, 4]);
  });
  it("同行空选区（锚点==光标）返回 null", () => {
    expect(lineSelRange(6, 0, { line: 0, col: 2 }, 0, 2)).toBeNull();
  });
  it("跨行：中间行整行选中，锚点/焦点行取到边界", () => {
    // 锚点 (0,1)、光标 (2,3)：行 0 从 1 到行尾、行 1 整行、行 2 从 0 到 3
    expect(lineSelRange(5, 0, { line: 0, col: 1 }, 2, 3)).toEqual([1, 5]);
    expect(lineSelRange(5, 1, { line: 0, col: 1 }, 2, 3)).toEqual([0, 5]);
    expect(lineSelRange(5, 2, { line: 0, col: 1 }, 2, 3)).toEqual([0, 3]);
  });
  it("跨行反向：光标在上方、锚点在下方（归一化）", () => {
    expect(lineSelRange(5, 0, { line: 2, col: 3 }, 0, 1)).toEqual([1, 5]);
  });
  it("选区范围外行返回 null", () => {
    expect(lineSelRange(5, 3, { line: 0, col: 1 }, 2, 3)).toBeNull();
  });
});
