import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import type { StreamEvent } from "../../src/core/index.js";
import type { Tool } from "../../src/tools/index.js";

function mockTextClient(...texts: string[]): ModelClient {
  return {
    async *stream() {
      for (const t of texts) yield { type: "text_delta", text: t };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

describe("Agent 主循环：模型对话闭环", () => {
  it("文本对话：调模型 → 拼装回复 → 无工具调用结束", async () => {
    const agent = new Agent({
      modelClient: mockTextClient("你好", "呀"),
      modelId: "mock",
      systemPrompt: "你是一个助手",
    });
    agent.start("你好");
    const events: StreamEvent[] = [];
    for await (const e of agent.run()) events.push(e);

    const messages = agent.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "你好" });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "你好呀" }],
    });
    // run 透传了模型流事件（含 done）
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });

  it("多轮对话：消息按轮次累积", async () => {
    const agent = new Agent({
      modelClient: mockTextClient("第一轮回复"),
      modelId: "mock",
      systemPrompt: "助手",
    });
    agent.start("第一个问题");
    for await (const _ of agent.run()) {
      // 消费事件流
    }
    agent.start("第二个问题");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const messages = agent.getMessages();
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: "user", content: "第一个问题" });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "第一轮回复" }],
    });
    expect(messages[2]).toEqual({ role: "user", content: "第二个问题" });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "第一轮回复" }],
    });
  });

  it("未知工具调用回灌为错误消息，模型据此继续", async () => {
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasToolResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasToolResult) {
            yield {
              type: "toolcall_start",
              index: 0,
              id: "call_1",
              name: "read",
            };
            yield { type: "toolcall_delta", index: 0, partialJson: '{"path":"a.ts"}' };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "明白了" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const messages = agent.getMessages();
    // user → assistant(工具调用) → tool_result(未知工具错误) → assistant(继续)
    expect(messages).toHaveLength(4);
    expect(messages[1]).toMatchObject({
      content: [{ type: "tool_call", id: "call_1", name: "read", input: { path: "a.ts" } }],
    });
    expect(messages[2]).toMatchObject({
      role: "tool_result",
      toolCallId: "call_1",
      isError: true,
      content: expect.stringContaining("未知工具"),
    });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "明白了" }],
    });
  });

  it("完整工具回合：模型请求工具 → 执行 → 结果回灌 → 模型继续", async () => {
    const echoTool: Tool = {
      name: "echo",
      description: "回显文本",
      inputSchema: z.object({ text: z.string() }),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: (input) => `回显：${(input as { text: string }).text}`,
    };
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasToolResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasToolResult) {
            yield { type: "toolcall_start", index: 0, id: "call_1", name: "echo" };
            yield { type: "toolcall_delta", index: 0, partialJson: '{"text":"hi"}' };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "工具已执行" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [echoTool],
    });
    agent.start("说 hi");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const messages = agent.getMessages();
    // user → assistant(工具调用) → tool_result → assistant(总结)
    expect(messages).toHaveLength(4);
    expect(messages[1]).toMatchObject({
      content: [{ type: "tool_call", id: "call_1", name: "echo" }],
    });
    expect(messages[2]).toMatchObject({
      role: "tool_result",
      toolCallId: "call_1",
      isError: false,
      content: "回显：hi",
    });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "工具已执行" }],
    });
  });
});
