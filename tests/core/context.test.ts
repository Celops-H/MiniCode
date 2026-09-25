import { describe, expect, it } from "vitest";
import { createContext } from "../../src/core/index.js";
import type { StreamEvent } from "../../src/core/index.js";

describe("Context", () => {
  it("createContext 用默认值构造", () => {
    const ctx = createContext("你是一个助手");
    expect(ctx).toEqual({ systemPrompt: "你是一个助手", messages: [], tools: [] });
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
