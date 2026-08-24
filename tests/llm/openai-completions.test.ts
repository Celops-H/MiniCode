import { describe, expect, it } from "vitest";
import {
  assembleAssistantMessage,
  assistantMessage,
  createContext,
  toolResultMessage,
  userMessage,
} from "../../src/core/index.js";
import type { StreamEvent } from "../../src/core/index.js";
import { OpenAICompletionsProtocol } from "../../src/llm/index.js";

async function* chunkGen(...vals: unknown[]): AsyncIterable<unknown> {
  for (const v of vals) yield v;
}

const protocol = new OpenAICompletionsProtocol();

describe("buildRequest：消息与工具转换", () => {
  it("user / assistant / tool_result 消息转换", () => {
    const context = createContext(
      "助手",
      [
        userMessage("你好"),
        assistantMessage([
          { type: "text", text: "回复" },
          { type: "tool_call", id: "call_1", name: "glob", input: { pattern: "*.ts" } },
        ]),
        toolResultMessage("call_1", "glob", "结果"),
      ],
    );
    const req = protocol.buildRequest(context) as {
      messages: Array<Record<string, unknown>>;
    };

    expect(req.messages[0]).toEqual({ role: "user", content: "你好" });
    expect(req.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "回复" }],
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "glob", arguments: '{"pattern":"*.ts"}' } },
      ],
    });
    expect(req.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "结果",
    });
  });

  it("thinking 块退化为 <thinking> 文本", () => {
    const context = createContext("s", [
      assistantMessage([{ type: "thinking", thinking: "内部推理" }]),
    ]);
    const req = protocol.buildRequest(context) as { messages: Array<Record<string, unknown>> };
    expect(req.messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "<thinking>内部推理</thinking>" }],
    });
  });

  it("工具 schema 转换为 function 格式", () => {
    const context = createContext("s", [], [
      { name: "read", description: "读文件", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    ]);
    const req = protocol.buildRequest(context) as { tools: unknown[] };
    expect(req.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "读文件",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ]);
  });

  it("无工具时不带 tools 字段", () => {
    const req = protocol.buildRequest(createContext("s")) as Record<string, unknown>;
    expect("tools" in req).toBe(false);
  });
});

describe("parseStream：SSE → 统一事件", () => {
  it("文本流 + finish_reason", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { choices: [{ delta: { role: "assistant", content: "你" }, index: 0 }] },
        { choices: [{ delta: { content: "好" }, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "你" },
      { type: "text_delta", text: "好" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("工具调用流：start → delta → end → done", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } },
                ],
              },
              index: 0,
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, index: 0 }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "toolcall_start", index: 0, id: "call_1", name: "read" },
      { type: "toolcall_delta", index: 0, partialJson: '{"path":' },
      { type: "toolcall_delta", index: 0, partialJson: '"a.ts"}' },
      { type: "toolcall_end", index: 0 },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("多个工具调用：各自独立 start/end", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "c0", type: "function", function: { name: "a", arguments: "" } },
                  { index: 1, id: "c1", type: "function", function: { name: "b", arguments: "" } },
                ],
              },
              index: 0,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "toolcall_start", index: 0, id: "c0", name: "a" },
      { type: "toolcall_start", index: 1, id: "c1", name: "b" },
      { type: "toolcall_end", index: 0 },
      { type: "toolcall_end", index: 1 },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("流中断异常：发 error 事件（观测）后原样抛出（控制流）", async () => {
    const events: StreamEvent[] = [];
    async function* throwingStream(): AsyncIterable<unknown> {
      yield { choices: [{ delta: { content: "部分" }, index: 0 }] };
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

  it("流意外结束（未收到 finish_reason）：补发工具结束并报 error", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } },
                ],
              },
              index: 0,
            },
          ],
        },
        // 流在此正常结束，无 finish_reason（厂商提前断流）
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "toolcall_start", index: 0, id: "call_1", name: "read" },
      { type: "toolcall_end", index: 0 },
      { type: "error", message: expect.stringContaining("未收到 finish_reason") },
    ]);
  });

  it("推理模型的 reasoning_content 归一化为 thinking_delta", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { choices: [{ delta: { reasoning_content: "先分析", index: 0 } }] },
        { choices: [{ delta: { reasoning_content: "再推理", content: "答案" }, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "thinking_delta", thinking: "先分析" },
      { type: "thinking_delta", thinking: "再推理" },
      { type: "text_delta", text: "答案" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("工具调用首 chunk 无 id：先发 start（无 id），id 后补时重复 start 携带补全值（消费端取最后值）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"path":' } }],
              },
              index: 0,
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '"a.ts"}' } }] }, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "toolcall_start", index: 0, id: undefined, name: undefined },
      { type: "toolcall_delta", index: 0, partialJson: '{"path":' },
      { type: "toolcall_start", index: 0, id: "call_1", name: "read" },
      { type: "toolcall_delta", index: 0, partialJson: '"a.ts"}' },
      { type: "toolcall_end", index: 0 },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("组装后 id 取后补值（assemble 增量更新，不退化 call_N 兜底）", async () => {
    const context = createContext("s");
    const assistant = await assembleAssistantMessage(
      protocol.parseStream(
        chunkGen(
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"path":' } }],
                },
                index: 0,
              },
            ],
          },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '"a.ts"}' } }] }, index: 0 }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
        ),
      ),
    );
    expect(assistant.content[0]).toMatchObject({ type: "tool_call", id: "call_1", name: "read" });
  });
});
