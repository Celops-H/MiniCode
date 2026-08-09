import { describe, expect, it } from "vitest";
import { appendMessage, createContext, userMessage } from "../../src/core/index.js";
import type { StreamEvent } from "../../src/core/index.js";

describe("Context", () => {
  it("createContext 用默认值构造", () => {
    const ctx = createContext("你是一个助手");
    expect(ctx).toEqual({ systemPrompt: "你是一个助手", messages: [], tools: [] });
  });

  it("appendMessage 追加消息并返回新对象，不改原对象", () => {
    const ctx = createContext("s", [userMessage("第一句")]);
    const next = appendMessage(ctx, userMessage("第二句"));

    expect(next.messages).toHaveLength(2);
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages).not.toBe(next.messages);
  });

  it("StreamEvent 的 type 可判别联合", () => {
    const events: StreamEvent[] = [
      { type: "text_delta", text: "a" },
      { type: "toolcall_delta", index: 0, partialJson: '{"path":' },
      { type: "done", stopReason: "end_turn" },
    ];
    expect(events.map((e) => e.type)).toEqual(["text_delta", "toolcall_delta", "done"]);
  });
});
