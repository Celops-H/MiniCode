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
      id: expect.any(String),
      content: [{ type: "text", text: "你好" }],
      meta: { stopReason: "stop" },
      timestamp: expect.any(String),
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
      { type: "thinking", thinking: "推理" },
      { type: "text", text: "答案" },
    ]);
  });

  it("思考签名并进同序号思考块（同模型回传校验必需）", async () => {
    const msg = await assembleAssistantMessage(
      events(
        { type: "thinking_delta", thinking: "推理", index: 0 },
        { type: "thinking_signature", index: 0, signature: "sig-1" },
        { type: "text_delta", text: "答案" },
        { type: "done", stopReason: "end_turn" },
      ),
    );
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "推理", signature: "sig-1" },
      { type: "text", text: "答案" },
    ]);
  });

  it("多思考块按序号各归一块，签名各随其块（交叉思考形态）", async () => {
    const msg = await assembleAssistantMessage(
      events(
        { type: "thinking_delta", thinking: "第一段", index: 0 },
        { type: "thinking_signature", index: 0, signature: "sig-0" },
        { type: "thinking_delta", thinking: "第二段", index: 2 },
        { type: "thinking_signature", index: 2, signature: "sig-2" },
        { type: "toolcall_start", index: 1, id: "c1", name: "read" },
        { type: "toolcall_end", index: 1 },
        { type: "done", stopReason: "tool_calls" },
      ),
    );
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "第一段", signature: "sig-0" },
      { type: "thinking", thinking: "第二段", signature: "sig-2" },
      { type: "tool_call", id: "c1", name: "read", input: {} },
    ]);
  });

  it("加密思考块保留为 redactedData（无明文也产出内容块，供同模型回传解密）", async () => {
    const msg = await assembleAssistantMessage(
      events(
        { type: "redacted_thinking", index: 0, data: "encrypted-blob" },
        { type: "text_delta", text: "答案" },
        { type: "done", stopReason: "end_turn" },
      ),
    );
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "", redactedData: "encrypted-blob" },
      { type: "text", text: "答案" },
    ]);
  });

  it("无序号的思考增量归同一块（openai 链无块概念，行为不变）", async () => {
    const msg = await assembleAssistantMessage(
      events(
        { type: "thinking_delta", thinking: "甲" },
        { type: "thinking_delta", thinking: "乙" },
        { type: "done", stopReason: "end_turn" },
      ),
    );
    expect(msg.content).toEqual([{ type: "thinking", thinking: "甲乙" }]);
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
    expect(msg).toEqual({ role: "assistant", id: expect.any(String), content: [], timestamp: expect.any(String) });
  });

  it("error 事件转为 meta 标记", async () => {
    const msg = await assembleAssistantMessage(events({ type: "error", message: "连接失败" }));
    expect(msg.meta?.stopReason).toBe("error: 连接失败");
  });

  it("纯空白思考/正文增量不产生内容块（厂商占位内容不再渲染空折叠块）", async () => {
    // glm-4.5-air 工具循环续轮发 reasoning_content="\n"（厂商模板行为）：
    // 如实组装会产出展开全空白的「思考」折叠块
    const msg = await assembleAssistantMessage(
      events(
        { type: "thinking_delta", thinking: "\n" },
        { type: "text_delta", text: "  \n " },
        { type: "done", stopReason: "end_turn" },
      ),
    );
    expect(msg.content).toEqual([]);
    // 真实内容照常产出，前后空白保留不裁剪
    const kept = await assembleAssistantMessage(
      events(
        { type: "thinking_delta", thinking: "\n推理\n" },
        { type: "text_delta", text: "\n答案\n" },
        { type: "done", stopReason: "end_turn" },
      ),
    );
    expect(kept.content).toEqual([
      { type: "thinking", thinking: "\n推理\n" },
      { type: "text", text: "\n答案\n" },
    ]);
  });

  it("done 携带的 usage 回填 meta.usage（真实用量）", async () => {
    const msg = await assembleAssistantMessage(
      events(
        { type: "text_delta", text: "回复" },
        { type: "done", stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 45 } },
      ),
    );
    expect(msg.meta).toEqual({ stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 45 } });
  });

  it("done 不带 usage 时 meta 无 usage 字段（厂商未给时契约不变）", async () => {
    const msg = await assembleAssistantMessage(
      events({ type: "text_delta", text: "回复" }, { type: "done", stopReason: "end_turn" }),
    );
    expect(msg.meta).toEqual({ stopReason: "end_turn" });
  });
});
