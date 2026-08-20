import { describe, expect, it } from "vitest";
import { truncateOutput } from "../../src/tools/index.js";

describe("truncateOutput（工具输出截断）", () => {
  it("未超限时原样返回，不标记截断", () => {
    expect(truncateOutput("短文本", 100)).toEqual({
      content: "短文本",
      truncated: false,
      originalLength: 3,
    });
  });

  it("未设上限时不截断", () => {
    const long = "x".repeat(1000);
    expect(truncateOutput(long)).toEqual({ content: long, truncated: false, originalLength: 1000 });
  });

  it("超限且限内无换行时按精确上限截断", () => {
    const content = "abcdefghij";
    expect(truncateOutput(content, 5)).toEqual({
      content: "abcde",
      truncated: true,
      originalLength: 10,
    });
  });

  it("超限且换行在限内后半段时按换行边界截断，保留完整行", () => {
    // 换行在 index 7（line1xx 之后），位于上限 10 的后半段（> 5），应切到换行前保留整行
    const content = "line1xx\nline2line3";
    expect(truncateOutput(content, 10).content).toBe("line1xx");
    expect(truncateOutput(content, 10).truncated).toBe(true);
  });

  it("超限但换行太靠前（限内前半段）时按精确上限截断", () => {
    // 换行在 index 1，位于上限 10 的前半段（≤ 5），应精确截断
    const content = "a\nbcdefghijk";
    expect(truncateOutput(content, 10).content).toBe("a\nbcdefghi");
  });

  it("空内容不截断", () => {
    expect(truncateOutput("", 5)).toEqual({ content: "", truncated: false, originalLength: 0 });
  });
});
