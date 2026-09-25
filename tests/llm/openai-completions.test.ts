import { describe, expect, it, vi } from "vitest";
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

/** 构造 ModelInfo（能力位测试用）：只需 id 与 reasoning 标记 */
function modelInfo(reasoning?: boolean): { id: string; name: string; api: "openai-chat-completions"; providerId: string; reasoning?: boolean } {
  return { id: "m", name: "m", api: "openai-chat-completions", providerId: "p", ...(reasoning ? { reasoning } : {}) };
}

describe("buildRequest：消息与工具转换", () => {
  it("emitReasoningEffort 开关 + 推理系列模型 + thinkingLevel → 带 reasoning_effort，否则不带（E60）", () => {
    const effProtocol = new OpenAICompletionsProtocol({ emitReasoningEffort: true });
    const withEff = effProtocol.buildRequest(createContext("s", [userMessage("hi")], [], "medium"), modelInfo(true)) as { reasoning_effort?: string };
    expect(withEff.reasoning_effort).toBe("medium");
    // 非推理系列模型（gpt-4o 类）：即使带 thinkingLevel 也不发（厂商对不支持的模型 400 且不可切换）
    const notReasoning = effProtocol.buildRequest(createContext("s", [userMessage("hi")], [], "medium"), modelInfo()) as { reasoning_effort?: string };
    expect(notReasoning.reasoning_effort).toBeUndefined();
    // 未传模型定义：等价于非推理模型，不发
    const noModel = effProtocol.buildRequest(createContext("s", [userMessage("hi")], [], "medium")) as { reasoning_effort?: string };
    expect(noModel.reasoning_effort).toBeUndefined();
    // 无 thinkingLevel：不带该字段
    const noLevel = effProtocol.buildRequest(createContext("s", [userMessage("hi")]), modelInfo(true)) as { reasoning_effort?: string };
    expect(noLevel.reasoning_effort).toBeUndefined();
    // 未开 emit 的厂商（deepseek/qwen 等）：即使带 thinkingLevel 也不发（防 400）
    const notEmit = protocol.buildRequest(createContext("s", [userMessage("hi")], [], "high"), modelInfo(true)) as { reasoning_effort?: string };
    expect(notEmit.reasoning_effort).toBeUndefined();
  });

  it("enableThinking 开关 + 推理系列模型 + thinkingLevel → 带 enable_thinking: true，否则不带（E60）", () => {
    const dashscopeProtocol = new OpenAICompletionsProtocol({ enableThinking: true });
    const withParam = dashscopeProtocol.buildRequest(createContext("s", [userMessage("hi")], [], "high"), modelInfo(true)) as { enable_thinking?: boolean };
    expect(withParam.enable_thinking).toBe(true);
    // 非推理系列模型：不发（DashScope 对不支持思考的模型发该参数无意义）
    const notReasoning = dashscopeProtocol.buildRequest(createContext("s", [userMessage("hi")], [], "high"), modelInfo()) as { enable_thinking?: boolean };
    expect(notReasoning.enable_thinking).toBeUndefined();
    // 未设思考等级：不发（厂商默认行为）
    const noLevel = dashscopeProtocol.buildRequest(createContext("s", [userMessage("hi")]), modelInfo(true)) as { enable_thinking?: boolean };
    expect(noLevel.enable_thinking).toBeUndefined();
    // 未开开关的厂商：即使带 thinkingLevel 也不发
    const notEnabled = protocol.buildRequest(createContext("s", [userMessage("hi")], [], "high"), modelInfo(true)) as { enable_thinking?: boolean };
    expect(notEnabled.enable_thinking).toBeUndefined();
  });
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

    expect(req.messages[0]).toEqual({ role: "system", content: "助手" });
    expect(req.messages[1]).toEqual({ role: "user", content: "你好" });
    expect(req.messages[2]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "回复" }],
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "glob", arguments: '{"pattern":"*.ts"}' } },
      ],
    });
    expect(req.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "结果",
    });
  });

  it("systemPrompt 转为首条 system 消息；为空时不占位", () => {
    const withSys = protocol.buildRequest(
      createContext("你是助手", [userMessage("hi")]),
    ) as { messages: Array<Record<string, unknown>> };
    expect(withSys.messages[0]).toEqual({ role: "system", content: "你是助手" });
    expect(withSys.messages[1]).toEqual({ role: "user", content: "hi" });

    const noSys = protocol.buildRequest(
      createContext("", [userMessage("hi")]),
    ) as { messages: Array<Record<string, unknown>> };
    expect(noSys.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("thinking 块退化为 <thinking> 文本", () => {
    const context = createContext("s", [
      assistantMessage([{ type: "thinking", thinking: "内部推理" }]),
    ]);
    const req = protocol.buildRequest(context) as { messages: Array<Record<string, unknown>> };
    expect(req.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "<thinking>内部推理</thinking>" }],
    });
  });

  it("reasoningContent 模式：thinking 回传为 reasoning_content 字段，content 只留文本", () => {
    const reasoningProtocol = new OpenAICompletionsProtocol({ reasoningContent: true });
    const context = createContext("s", [
      assistantMessage([
        { type: "thinking", thinking: "内部推理" },
        { type: "text", text: "回复" },
      ]),
    ]);
    const req = reasoningProtocol.buildRequest(context) as { messages: Array<Record<string, unknown>> };
    expect(req.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "回复" }],
      reasoning_content: "内部推理",
    });
  });

  it("reasoningContent 模式：只有 thinking 的 assistant 退化进 content（不缺 content/tool_calls 触发 400）", () => {
    const reasoningProtocol = new OpenAICompletionsProtocol({ reasoningContent: true });
    // 思考中打断收尾会落下只有 thinking 的 assistant（无文本、无工具调用）
    const req = reasoningProtocol.buildRequest(createContext("s", [
      assistantMessage([{ type: "thinking", thinking: "思考中的半截" }]),
    ])) as { messages: Array<Record<string, unknown>> };
    expect(req.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "<thinking>思考中的半截</thinking>" }],
    });
    // 退化时不设 reasoning_content，避免只有该字段的 assistant 被厂商拒收
    expect((req.messages[1] as Record<string, unknown>).reasoning_content).toBeUndefined();
  });

  it("reasoningContent 模式：thinking + tool_call（无正文）→ reasoning_content 与 tool_calls 并存", () => {
    const reasoningProtocol = new OpenAICompletionsProtocol({ reasoningContent: true });
    const context = createContext("s", [
      assistantMessage([
        { type: "thinking", thinking: "决定先读文件" },
        { type: "tool_call", id: "call_1", name: "read", input: { path: "a.ts" } },
      ]),
    ]);
    const req = reasoningProtocol.buildRequest(context) as { messages: Array<Record<string, unknown>> };
    // 思考后直接调工具：thinking 回传 reasoning_content、调用序列化 tool_calls，产品不退化
    expect(req.messages[1]).toEqual({
      role: "assistant",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } },
      ],
      reasoning_content: "决定先读文件",
    });
  });

  it("空 assistant（无文本/无工具/无思考）续跑时从请求体丢弃（防 400 残留面）", () => {
    const context = createContext("s", [assistantMessage([])]);
    const req = protocol.buildRequest(context) as { messages: Array<Record<string, unknown>> };
    // 完整轮无任何产出落下的空 assistant 没有信息，直接不发
    expect(req.messages).toEqual([{ role: "system", content: "s" }]);
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

  it("content 块数组（glm 等兼容厂商格式）：取文本块拼接为 text_delta（P10）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { choices: [{ delta: { content: [{ type: "text", text: "正文" }, { type: "refusal" }] }, index: 0 }] },
        { choices: [{ delta: { content: [{ type: "text", text: "继续" }] }, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "正文" },
      { type: "text_delta", text: "继续" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("content 块数组全无文本：不产 text_delta（不空发，审查补）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { choices: [{ delta: { content: [{ type: "refusal" }, { type: "tool_call" }] }, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([{ type: "done", stopReason: "stop" }]);
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

  it("推理模型的 reasoning_content 统一成 thinking_delta", async () => {
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

describe("parseStream：E16 五类现象", () => {
  it("content 块数组里的思考块路由进思考管道（glm 思考+正文根因）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        {
          choices: [
            {
              delta: {
                content: [
                  { type: "thinking", thinking: "先想" },
                  { type: "text", text: "正文" },
                ],
              },
              index: 0,
            },
          ],
        },
        { choices: [{ delta: { content: [{ reasoning_content: "再想" }, { type: "text", text: "续" }] }, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "thinking_delta", thinking: "先想" },
      { type: "text_delta", text: "正文" },
      { type: "thinking_delta", thinking: "再想" },
      { type: "text_delta", text: "续" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("正文累积全文下发时剥离前缀（防滚雪球重复）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { choices: [{ delta: { content: "第一段" }, index: 0 }] },
        { choices: [{ delta: { content: "第一段第二段" }, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "第一段" },
      { type: "text_delta", text: "第二段" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("思考累积全文下发时同样剥离前缀", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { choices: [{ delta: { reasoning_content: "思考" }, index: 0 }] },
        { choices: [{ delta: { reasoning_content: "思考续" }, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "thinking_delta", thinking: "思考" },
      { type: "thinking_delta", thinking: "续" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("正文里的 <thinking> 标签转回思考事件（模型模仿历史编码格式）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { choices: [{ delta: { content: "<thinking>推理</thinking>答案" }, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "thinking_delta", thinking: "推理" },
      { type: "text_delta", text: "答案" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("正文里的 <tool_call> 标签转回工具调用事件，与原生工具调用不撞号", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        {
          choices: [
            { delta: { content: '<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>' }, index: 0 },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: "{}" } }] }, index: 0 },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
      ),
    )) {
      events.push(e);
    }
    // 标签工具占序号 0（先到），原生工具调用重编号为 1：两类来源共用计数器
    expect(events).toEqual([
      { type: "toolcall_start", index: 0, id: "inline_0", name: "read" },
      { type: "toolcall_delta", index: 0, partialJson: '{"path":"a.ts"}' },
      { type: "toolcall_end", index: 0 },
      { type: "toolcall_start", index: 1, id: "call_1", name: "bash" },
      { type: "toolcall_delta", index: 1, partialJson: "{}" },
      { type: "toolcall_end", index: 1 },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("finish_reason 之后补发的正文不丢：done 延到流尾发出", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { choices: [{ delta: { content: "主" }, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
        { choices: [{ delta: { content: "补发" }, index: 0 }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "主" },
      { type: "text_delta", text: "补发" },
      { type: "done", stopReason: "stop" },
    ]);
  });
});

describe("parseStream：E56 流内 error 载荷", () => {
  it("HTTP 200 SSE 里无 choices、带 error 对象的 chunk：解析出真实原因转 error 事件", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen({ error: { message: "额度已用尽", type: "insufficient_quota", code: "quota_exceeded" } }),
    )) {
      events.push(e);
    }
    // 真实原因直达消费端，且不再补「流意外结束」把它顶掉
    expect(events).toEqual([{ type: "error", message: "额度已用尽" }]);
  });

  it("error 载荷为字符串形态时同样解析（one-api 各版本形态不一）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(chunkGen({ error: "无可用渠道" }))) {
      events.push(e);
    }
    expect(events).toEqual([{ type: "error", message: "无可用渠道" }]);
  });

  it("error 载荷对象无 message 字段：序列化整个对象保底，不静默吞", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(chunkGen({ error: { code: 1302 } }))) {
      events.push(e);
    }
    expect(events).toEqual([{ type: "error", message: '{"code":1302}' }]);
  });

  it("error 载荷为退化形态（false/空对象）：占位噪声不当真实错误，维持静默跳过（E56 review 补）", async () => {
    for (const degenerate of [false, {}, 0]) {
      const events: StreamEvent[] = [];
      for await (const e of protocol.parseStream(chunkGen({ error: degenerate }))) {
        events.push(e);
      }
      // 不产出「false」「{}」这类误导性错误事件，回落流尾的通用「流意外结束」
      expect(events).toEqual([{ type: "error", message: "流意外结束（未收到 finish_reason）" }]);
    }
  });

  it("error chunk 之后流正常结束有 finish_reason：error 仅作观测，done 照发", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { error: { message: "上游抖动" } },
        { choices: [{ delta: { content: "恢复" }, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "error", message: "上游抖动" },
      { type: "text_delta", text: "恢复" },
      { type: "done", stopReason: "stop" },
    ]);
  });
});

describe("parseStream：E62 两处兜底", () => {
  it("tool_calls 缺 index、有 id：按新调用分组（此前整条调用被丢弃）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        {
          choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"path":' } }] } }],
        },
        { choices: [{ delta: { tool_calls: [{ function: { arguments: '"a.ts"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ),
    )) {
      events.push(e);
    }
    // 首片有 id 开新调用；续片无 id 无 index 归并最近打开的调用，参数完整
    expect(events).toEqual([
      { type: "toolcall_start", index: 0, id: "call_1", name: "read" },
      { type: "toolcall_delta", index: 0, partialJson: '{"path":' },
      { type: "toolcall_delta", index: 0, partialJson: '"a.ts"}' },
      { type: "toolcall_end", index: 0 },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("tool_calls 缺 index 且无 id 且无已打开调用：无处归属跳过，后续 id 片照常开调用", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        // 参数先到、id 未到（先发参数后补 id 的厂商形态），且无已打开调用可归并
        { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"x":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "read", arguments: '"1"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "toolcall_start", index: 0, id: "call_1", name: "read" },
      { type: "toolcall_delta", index: 0, partialJson: '"1"}' },
      { type: "toolcall_end", index: 0 },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("tool_calls 缺 index 且每片重发同一 id：归并同一条调用，不裂成多条（E62 review 补）", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"path":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ id: "call_1", function: { arguments: '"a.ts"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ),
    )) {
      events.push(e);
    }
    // 若每片都开新调用，截断参数会各自解析失败、工具以空参数真实执行
    expect(events).toEqual([
      { type: "toolcall_start", index: 0, id: "call_1", name: "read" },
      { type: "toolcall_delta", index: 0, partialJson: '{"path":' },
      { type: "toolcall_delta", index: 0, partialJson: '"a.ts"}' },
      { type: "toolcall_end", index: 0 },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("多个无 index 调用各自成组：有 id 即新调用、续片归并最近打开者", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        { choices: [{ delta: { tool_calls: [{ id: "c0", function: { name: "a", arguments: '{"p":1}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ id: "c1", function: { name: "b", arguments: '{"q":2}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "toolcall_start", index: 0, id: "c0", name: "a" },
      { type: "toolcall_delta", index: 0, partialJson: '{"p":1}' },
      { type: "toolcall_start", index: 1, id: "c1", name: "b" },
      { type: "toolcall_delta", index: 1, partialJson: '{"q":2}' },
      { type: "toolcall_end", index: 0 },
      { type: "toolcall_end", index: 1 },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  it("厂商不支持真流式、完整 message 单 chunk 下发：回落读 message 不再全丢", async () => {
    const events: StreamEvent[] = [];
    for await (const e of protocol.parseStream(
      chunkGen(
        {
          choices: [
            {
              message: { role: "assistant", content: "完整回复", reasoning_content: "先思考" },
              finish_reason: "stop",
            },
          ],
        },
      ),
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "thinking_delta", thinking: "先思考" },
      { type: "text_delta", text: "完整回复" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("message 形式的 tool_calls（无 index 有 id）完整组装成 tool_call 块（E62 a+b 组合）", async () => {
    const assistant = await assembleAssistantMessage(
      protocol.parseStream(
        chunkGen(
          {
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ),
      ),
    );
    expect(assistant.content[0]).toMatchObject({
      type: "tool_call",
      id: "call_1",
      name: "read",
      input: { path: "a.ts" },
    });
  });
});

describe("parseStream：E68 零产出 chunk 诊断", () => {
  /** 捕获诊断 stderr 输出（E68 报告走 process.stderr.write） */
  async function captureDiagnostics(run: () => Promise<void>): Promise<string[]> {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((line: unknown) => {
      writes.push(String(line));
      return true;
    }) as typeof process.stderr.write);
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return writes;
  }

  it("调试开关开启：零产出 chunk 记入诊断，流结束时输出计数与样本", async () => {
    const debugProtocol = new OpenAICompletionsProtocol({ debugDroppedChunks: true });
    const writes = await captureDiagnostics(async () => {
      for await (const _ of debugProtocol.parseStream(
        chunkGen(
          { choices: [{ delta: { role: "assistant" }, index: 0 }] },
          { id: "gen-1", created: 1, model: "glm-4.5-air", choices: [{ delta: {}, index: 0 }] },
          { choices: [{ delta: { content: "hi" }, index: 0 }] },
          { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
        ),
      )) {
        // 消费流
      }
    });
    const report = writes.join("");
    expect(report).toContain("流解析诊断");
    expect(report).toContain("4 个 chunk");
    // 零产出 3 个：仅 role 的 chunk、厂商元信息空 delta、finish_reason 收尾 chunk（无工具打开时只补 end）
    expect(report).toContain("3 个未产出任何事件");
    expect(report).toContain("glm-4.5-air");
  });

  it("调试开关关闭（默认）：零产出 chunk 静默跳过，无任何诊断输出（无行为改变）", async () => {
    const writes = await captureDiagnostics(async () => {
      for await (const _ of protocol.parseStream(
        chunkGen(
          { choices: [{ delta: { role: "assistant" }, index: 0 }] },
          { choices: [{ delta: { content: "hi" }, index: 0 }] },
          { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
        ),
      )) {
        // 消费流
      }
    });
    expect(writes).toEqual([]);
  });

  it("流中断异常收尾时诊断仍输出（静默卡死多由用户打断才结束，证据不能丢）", async () => {
    const debugProtocol = new OpenAICompletionsProtocol({ debugDroppedChunks: true });
    async function* silentThenThrow(): AsyncIterable<unknown> {
      yield { choices: [{ delta: { role: "assistant" }, index: 0 }] };
      throw new Error("连接中断");
    }
    const writes = await captureDiagnostics(async () => {
      await expect(async () => {
        for await (const _ of debugProtocol.parseStream(silentThenThrow())) {
          // 消费流以触发异常
        }
      }).rejects.toThrow("连接中断");
    });
    expect(writes.join("")).toContain("1 个未产出任何事件");
  });

  it("超长零产出 chunk 的样本截断，保留可辨识度（E68 review 补）", async () => {
    const debugProtocol = new OpenAICompletionsProtocol({ debugDroppedChunks: true });
    const writes = await captureDiagnostics(async () => {
      for await (const _ of debugProtocol.parseStream(
        chunkGen(
          { choices: [{ delta: { role: "assistant", content: "" }, index: 0 }], padding: "x".repeat(300) },
          { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
        ),
      )) {
        // 消费流
      }
    });
    const report = writes.join("");
    expect(report).toContain("...(len ");
  });
});
