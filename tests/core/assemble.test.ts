import { describe, expect, it } from "vitest";
import { assembleAssistantMessage } from "../../src/core/index.js";
import type { StreamEvent } from "../../src/core/index.js";

async function* events(...items: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of items) yield e;
}

describe("事件收集器", () => {
  it("纯文本流拼装为一个 text 块并带 stopReason", async () => {
    const msg = await assembleAssistantMessage(
      events(
        { type: "text_delta", text: "你" },
        { type: "text_delta", text: "好" },
        { type: "done", stopReason: "stop" },
      ),
    );
    expect(msg).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "你好" }],
      meta: { stopReason: "stop" },
    });
  });

  it("思考流拼装为 thinking 块", async () => {
    const msg = await assembleAssistantMessage(
      events(
        { type: "thinking_delta", thinking: "推" },
        { type: "thinking_delta", thinking: "理" },
        { type: "text_delta", text: "答案" },
        { type: "done", stopReason: "end_turn" },
      ),
    );
    expect(msg.content).toEqual([
      { type: "text", text: "答案" },
      { type: "thinking", thinking: "推理" },
    ]);
  });

  it("工具调用增量拼接并解析参数", async () => {
    const msg = await assembleAssistantMessage(
      events(
        { type: "toolcall_start", index: 0, id: "call_1", name: "read" },
        { type: "toolcall_delta", index: 0, partialJson: '{"path":' },
        { type: "toolcall_delta", index: 0, partialJson: '"a.ts"}' },
        { type: "toolcall_end", index: 0 },
        { type: "done", stopReason: "tool_calls" },
      ),
    );
    expect(msg.content[0]).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "read",
      input: { path: "a.ts" },
    });
    expect(msg.meta?.stopReason).toBe("tool_calls");
  });

  it("多个工具调用按 index 顺序排列", async () => {
    const msg = await assembleAssistantMessage(
      events(
        { type: "toolcall_start", index: 1, id: "c1", name: "b" },
        { type: "toolcall_start", index: 0, id: "c0", name: "a" },
        { type: "toolcall_end", index: 1 },
        { type: "toolcall_end", index: 0 },
        { type: "done", stopReason: "tool_calls" },
      ),
    );
    expect(msg.content.map((c) => (c.type === "tool_call" ? c.name : null))).toEqual(["a", "b"]);
  });

  it("工具参数非法 JSON 时 input 为空对象", async () => {
    const msg = await assembleAssistantMessage(
      events(
        { type: "toolcall_start", index: 0, id: "c0", name: "x" },
        { type: "toolcall_delta", index: 0, partialJson: "{oops" },
        { type: "done", stopReason: "tool_calls" },
      ),
    );
    expect(msg.content[0]).toEqual({
      type: "tool_call",
      id: "c0",
      name: "x",
      input: {},
    });
  });

  it("无工具调用结束（end_turn）不带 stopReason 时也正常", async () => {
    const msg = await assembleAssistantMessage(events());
    expect(msg).toEqual({ role: "assistant", content: [] });
  });

  it("error 事件转为 meta 标记", async () => {
    const msg = await assembleAssistantMessage(events({ type: "error", message: "连接失败" }));
    expect(msg.meta?.stopReason).toBe("error: 连接失败");
  });
});
