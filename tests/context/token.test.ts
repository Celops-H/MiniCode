import { describe, expect, it } from "vitest";
import { estimateTextTokens, estimateTokens, needsCompact } from "../../src/context/index.js";
import type { Message } from "../../src/core/index.js";

describe("estimateTokens（token 估算）", () => {
  it("空消息估算为 0", () => {
    expect(estimateTokens([])).toBe(0);
  });

  it("中文按 CJK 系数计价（1 token/字符，E79）", () => {
    const messages: Message[] = [{ role: "user", id: "u1", content: "你好世界" }];
    // 4 个 CJK 字符 × 1 = 4（旧单一系数 0.3 只算 1.2，对中文低估 3 倍）
    expect(estimateTokens(messages)).toBe(4);
  });

  it("工具结果按内容长度估算（非 CJK 0.25/字符）", () => {
    const messages: Message[] = [
      {
        role: "tool_result",
        id: "tr1",
        toolCallId: "c1",
        toolName: "read",
        isError: false,
        content: "a".repeat(100),
        timestamp: "t",
      },
    ];
    expect(estimateTokens(messages)).toBe(25); // 100 × 0.25
  });

  it("模型回复统计文本、思考与工具调用（混合分段计价）", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        id: "a1",
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "思考" },
          { type: "tool_call", id: "c1", name: "read", input: { path: "/tmp/a.ts" } },
        ],
      },
    ];
    // text 5×0.25=1.25 + thinking 2×1=2 + (name 4 + JSON 20)×0.25=6 → 9.25 → ceil 10
    expect(estimateTokens(messages)).toBe(10);
  });
});

describe("estimateTextTokens（文本 token 估算，E15/E79）", () => {
  it("与消息同口径：CJK 记 1、其余记 0.25，向上取整", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("a".repeat(100))).toBe(25);
    expect(estimateTextTokens("a".repeat(101))).toBe(26);
    expect(estimateTextTokens("中文两句")).toBe(4);
    // 混合：2 CJK + 4 其他 = 2 + 1 = 3
    expect(estimateTextTokens("中文abc?")).toBe(3);
  });
});

describe("needsCompact（触发判断）", () => {
  const options = { contextWindow: 10000, maxOutputTokens: 2000, safetyMargin: 1000 };

  it("估算 token 超过可用窗口时触发", () => {
    expect(needsCompact(7001, options)).toBe(true); // 可用 = 7000
  });

  it("估算 token 未超可用窗口时不触发", () => {
    expect(needsCompact(6999, options)).toBe(false);
  });

  it("恰好等于可用窗口时触发（保守）", () => {
    expect(needsCompact(7000, options)).toBe(true);
  });
});
