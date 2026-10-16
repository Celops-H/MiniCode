import { describe, expect, it } from "vitest";
import { hashText } from "../../src/core/index.js";

describe("hashText：短文本指纹", () => {
  it("同文本恒同值，不同文本不同值", () => {
    expect(hashText("MiniCode")).toBe(hashText("MiniCode"));
    expect(hashText("MiniCode")).not.toBe(hashText("MiniCode2"));
  });

  it("算法固定（FNV-1a base36）：两处调用方必须得到同一个值", () => {
    expect(hashText("MiniCode")).toBe("1dlzeu2");
    expect(hashText("")).toBe("1kl6d44");
  });
});
