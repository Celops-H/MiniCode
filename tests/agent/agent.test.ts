import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import type { StreamEvent } from "../../src/core/index.js";

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

  it("模型返回工具调用时：主循环识别但暂不执行（工具执行后续接入）", async () => {
    const agent = new Agent({
      modelClient: {
        async *stream() {
          yield {
            type: "toolcall_start",
            index: 0,
            id: "call_1",
            name: "read",
          };
          yield { type: "toolcall_delta", index: 0, partialJson: '{"path":"a.ts"}' };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
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
    const assistant = messages.at(-1);
    expect(assistant?.role).toBe("assistant");
    // 拼装出工具调用块
    expect(assistant).toMatchObject({
      content: [{ type: "tool_call", id: "call_1", name: "read", input: { path: "a.ts" } }],
    });
  });
});
