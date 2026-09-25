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

  it("空 assistant（无文本/无工具/无思考）续跑时从请求体丢弃（E55，与 openai 侧对称）", () => {
    // 完整轮无产出落下的空 assistant 跨协议续跑会被严格校验端点 400
    const context = createContext("s", [
      userMessage("hi"),
      assistantMessage([]),
      toolResultMessage("call_1", "read", "内容"),
    ]);
    const req = protocol.buildRequest(context) as { messages: Array<Record<string, unknown>> };
    // 空 assistant 被跳过；相邻的 user 正文与工具结果合并为一条 user 消息
    //（严格校验端点要求角色交替），内容块顺序不变
    expect(req.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_result", tool_use_id: "call_1", content: "内容", is_error: false },
        ],
      },
    ]);
  });

  it("空 assistant 过滤后相邻 user 合并为一条（错误轮后继续对话的真实序列）", () => {
    // 真实形态：错误轮（无产出 assistant）之后用户再发消息，历史为
    // [user, assistant([]), user]——不合并会发出相邻同角色 user，严格校验端点 400
    const context = createContext("s", [
      userMessage("第一条"),
      assistantMessage([]),
      userMessage("继续"),
    ]);
    const req = protocol.buildRequest(context) as { messages: Array<Record<string, unknown>> };
    expect(req.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "第一条" }, { type: "text", text: "继续" }],
      },
    ]);
  });

  it("非相邻 user 不受合并影响（中间隔非空 assistant）", () => {
    const context = createContext("s", [
      userMessage("第一条"),
      assistantMessage([{ type: "text", text: "回复" }]),
      userMessage("继续"),
    ]);
    const req = protocol.buildRequest(context) as { messages: Array<Record<string, unknown>> };
    expect(req.messages).toEqual([
      { role: "user", content: "第一条" },
      { role: "assistant", content: [{ type: "text", text: "回复" }] },
      { role: "user", content: "继续" },
    ]);
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

  it("error 事件取可读消息（E96）：对象取 message ?? type，字符串直用，不再 [object Object]", async () => {
    async function collect(...chunks: unknown[]): Promise<StreamEvent[]> {
      const events: StreamEvent[] = [];
      for await (const e of protocol.parseStream(chunkGen(...chunks))) {
        events.push(e);
      }
      return events;
    }
    // 官方 overloaded_error 形态：对象带 type，无 message
    expect(await collect({ type: "error", error: { type: "overloaded_error" } })).toEqual([
      { type: "error", message: "overloaded_error" },
    ]);
    // 对象带 message：优先取 message（api_error 等形态）
    expect(
      await collect({ type: "error", error: { type: "api_error", message: "Internal server error" } }),
    ).toEqual([{ type: "error", message: "Internal server error" }]);
    // 字符串直用（部分兼容端点）
    expect(await collect({ type: "error", error: "过载" })).toEqual([{ type: "error", message: "过载" }]);
    // 退化形态（空串/0/false）：占位噪声报通用文案，不产出「0」「false」「空串」误导
    expect(await collect({ type: "error", error: "" })).toEqual([{ type: "error", message: "未知错误" }]);
    expect(await collect({ type: "error", error: 0 })).toEqual([{ type: "error", message: "未知错误" }]);
    expect(await collect({ type: "error", error: false })).toEqual([{ type: "error", message: "未知错误" }]);
    // 无 message/type 的对象：序列化保留错误信号
    expect(await collect({ type: "error", error: { code: 1302 } })).toEqual([
      { type: "error", message: '{"code":1302}' },
    ]);
    // error 缺失：通用文案
    expect(await collect({ type: "error" })).toEqual([{ type: "error", message: "未知错误" }]);
  });

  it("流意外结束（未收到 message_stop）报 error 标记异常轮", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(chunkGen())) {
      events.push(e);
    }
    expect(events).toEqual([{ type: "error", message: expect.stringContaining("未收到 message_stop") }]);
  });

  it("流尾已收到 stop_reason 而缺 message_stop：按正常完成收 done（E47 收尾宽限关流）", async () => {
    // 厂商发完 message_delta（停止原因已到）后握着连接不发 message_stop，
    // 收尾宽限关流后落到流尾收尾分支——响应逻辑上已完整，不再误报异常轮
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "你好" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("后续只带 usage 的 message_delta 不清掉已收到的停止原因（审查修正）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_delta", delta: { usage: { output_tokens: 5 } } },
      ),
    )) {
      events.push(e);
    }
    // 只带 usage 的 message_delta：停止原因保留，用量被解析挂 done（E63）
    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: "end_turn",
      usage: { outputTokens: 5 },
    });
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

describe("parseStream：E16 五类现象", () => {
  it("空 text/thinking delta 不发事件（全空流不产出空内容块）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([{ type: "done", stopReason: "end_turn" }]);
  });

  it("content_block_start 携带的首段内容不丢（部分兼容端点不放 delta）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "首段" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "续" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "首段" },
      { type: "text_delta", text: "续" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("正文里的 <thinking> 标签转回思考事件", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "<thinking>推理</thinking>答案" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "thinking_delta", thinking: "推理" },
      { type: "text_delta", text: "答案" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("正文累积全文下发时剥离前缀（防滚雪球重复）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "第一段" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "第一段第二段" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "第一段" },
      { type: "text_delta", text: "第二段" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("映射不到块 index 的参数增量跳过（不再兜底并到工具 0 污染参数流）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "call_1", name: "read" } },
        // 块 index 2 从未 start：增量无归属
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"x":1}' } },
        { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } },
        { type: "content_block_stop", index: 3 },
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
        { type: "message_stop" },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "toolcall_start", index: 0, id: "call_1", name: "read" },
      { type: "toolcall_delta", index: 0, partialJson: '{"path":"a.ts"}' },
      { type: "toolcall_end", index: 0 },
      { type: "done", stopReason: "tool_use" },
    ]);
  });

  it("ping 等未知事件静默通过，不影响解析", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "ping" },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "好" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });
});

describe("parseStream：真实用量挂 done（E63）", () => {
  it("message_start 的 input_tokens 与 message_delta 的累计 output_tokens → done.usage", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "message_start", message: { usage: { input_tokens: 88, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", usage: { output_tokens: 27 } } },
        { type: "message_stop" },
      ),
    )) {
      events.push(e);
    }
    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 88, outputTokens: 27 },
    });
  });

  it("缺 message_delta 用量的兼容端点回落 message_start 的 output_tokens", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "message_start", message: { usage: { input_tokens: 88, output_tokens: 5 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ),
    )) {
      events.push(e);
    }
    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 88, outputTokens: 5 },
    });
  });

  it("E47 收尾宽限关流路径（缺 message_stop）同样携带用量", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "message_start", message: { usage: { input_tokens: 10 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", usage: { output_tokens: 3 } } },
      ),
    )) {
      events.push(e);
    }
    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 3 },
    });
  });

  it("厂商未给用量时 done 不带 usage（契约不变）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ),
    )) {
      events.push(e);
    }
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });
});

describe("parseStream：E16 审查修正", () => {
  it("message_stop 前省略 content_block_stop：未闭合标签残料 flush 后再 done", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "开头<thinking>残料" } },
        // 兼容端点直接收尾，无 content_block_stop
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "开头" },
      // 未闭合的 thinking 段残料按思考发出，不随 message_stop 丢失
      { type: "thinking_delta", thinking: "残料" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });
});
