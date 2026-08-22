import { describe, expect, it } from "vitest";
import { estimateTokens, needsCompact } from "../../src/context/index.js";
import type { Message } from "../../src/core/index.js";

describe("estimateTokens（token 估算）", () => {
  it("空消息估算为 0", () => {
    expect(estimateTokens([])).toBe(0);
  });

  it("用户消息按字符数 × 系数估算", () => {
    const messages: Message[] = [{ role: "user", content: "你好世界" }];
    // 4 字符 × 0.3 = 1.2 → ceil 2
    expect(estimateTokens(messages)).toBe(2);
  });

  it("工具结果按内容长度估算", () => {
    const messages: Message[] = [
      {
        role: "tool_result",
        toolCallId: "c1",
        toolName: "read",
        isError: false,
        content: "a".repeat(100),
        timestamp: "t",
      },
    ];
    expect(estimateTokens(messages)).toBe(30); // 100 × 0.3
  });

  it("模型回复统计文本、思考与工具调用", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "思考" },
          { type: "tool_call", id: "c1", name: "read", input: { path: "/tmp/a.ts" } },
        ],
      },
    ];
    // text 5 + thinking 2 + name 4 + input JSON 20 = 31 字符 × 0.3 = 9.3 → 10
    expect(estimateTokens(messages)).toBe(10);
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
