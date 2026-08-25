import { describe, expect, it } from "vitest";
import {
  assistantMessage,
  createContext,
  toolResultMessage,
  userMessage,
} from "../../src/core/index.js";
import type { StreamEvent } from "../../src/core/index.js";
import { AnthropicMessagesProtocol } from "../../src/llm/index.js";

async function* chunkGen(...vals: unknown[]): AsyncIterable<unknown> {
  for (const v of vals) yield v;
}

const protocol = new AnthropicMessagesProtocol();

describe("buildRequest：消息与工具转换", () => {
  it("user / assistant / tool_result 转换，工具结果归并进 user 消息", () => {
    const context = createContext(
      "助手",
      [
        userMessage("你好"),
        assistantMessage([
          { type: "text", text: "我查一下" },
          { type: "tool_call", id: "call_1", name: "glob", input: { pattern: "*.ts" } },
        ]),
        toolResultMessage("call_1", "glob", "a.ts"),
      ],
    );
    const req = protocol.buildRequest(context) as { messages: Array<Record<string, unknown>> };

    expect(req.messages[0]).toEqual({ role: "user", content: "你好" });
    expect(req.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "我查一下" },
        { type: "tool_use", id: "call_1", name: "glob", input: { pattern: "*.ts" } },
      ],
    });
    // 工具结果归并进一条 user 消息，带 tool_use_id 与 is_error
    expect(req.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "a.ts", is_error: false }],
    });
  });

  it("thinking 块退化为文本（无 signature）", () => {
    const context = createContext("s", [
      assistantMessage([{ type: "thinking", thinking: "内部推理" }]),
    ]);
    const req = protocol.buildRequest(context) as { messages: Array<Record<string, unknown>> };
    expect(req.messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "<thinking>内部推理</thinking>" }],
    });
  });

  it("工具 schema 转换为 input_schema 格式", () => {
    const context = createContext("s", [], [
      { name: "read", description: "读文件", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    ]);
    const req = protocol.buildRequest(context) as { tools: unknown[] };
    expect(req.tools).toEqual([
      {
        name: "read",
        description: "读文件",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  it("systemPrompt 放顶层 system 字段；为空时不带", () => {
    const req = protocol.buildRequest(
      createContext("你是助手", [userMessage("hi")]),
    ) as Record<string, unknown>;
    expect(req.system).toBe("你是助手");

    const noSys = protocol.buildRequest(
      createContext("", [userMessage("hi")]),
    ) as Record<string, unknown>;
    expect("system" in noSys).toBe(false);
  });

  it("无工具时不带 tools 字段", () => {
    const req = protocol.buildRequest(createContext("s")) as Record<string, unknown>;
    expect("tools" in req).toBe(false);
  });
});

describe("parseStream：SSE → 统一事件", () => {
  it("文本流 + message_delta 停止原因", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "message_start", message: { id: "m1" } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "你" },
      { type: "text_delta", text: "好" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("工具调用流：tool_use 经 input_json_delta 增量到达", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "read", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
        { type: "message_stop" },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "toolcall_start", index: 0, id: "call_1", name: "read" },
      { type: "toolcall_delta", index: 0, partialJson: '{"path":' },
      { type: "toolcall_delta", index: 0, partialJson: '"a.ts"}' },
      { type: "toolcall_end", index: 0 },
      { type: "done", stopReason: "tool_use" },
    ]);
  });

  it("thinking_delta 统一成思考增量", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "推理" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "thinking_delta", thinking: "推理" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("error 事件转为错误事件", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen({ type: "error", error: { type: "overloaded_error" } }),
    )) {
      events.push(e);
    }
    expect(events[0]).toMatchObject({ type: "error" });
  });

  it("流中断异常：发 error 事件（观测）后原样抛出（控制流）", async () => {
    const events: StreamEvent[] = [];
    async function* throwingStream(): AsyncIterable<unknown> {
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "部分" } };
      throw new Error("连接中断");
    }
    let thrown: string | undefined;
    try {
      for await (const e of protocol.parseStream(throwingStream())) {
        events.push(e);
      }
    } catch (err) {
      thrown = (err as Error).message;
    }
    expect(events).toEqual([
      { type: "text_delta", text: "部分" },
      { type: "error", message: "连接中断" },
    ]);
    expect(thrown).toBe("连接中断");
  });
});
