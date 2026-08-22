import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import { HookBus } from "../../src/hooks/index.js";

function mockTextClient(text: string): ModelClient {
  return {
    async *stream() {
      yield { type: "text_delta", text };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

describe("Agent 接入 Hook 事件", () => {
  it("run 处理用户输入前触发 UserPromptSubmit（携带输入内容）", async () => {
    const hooks = new HookBus();
    const handler = vi.fn();
    hooks.on("UserPromptSubmit", handler);
    const agent = new Agent({
      modelClient: mockTextClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
    });
    agent.start("你好");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: "UserPromptSubmit", input: "你好" });
  });

  it("SessionStart 在首次 run 触发且只触发一次", async () => {
    const hooks = new HookBus();
    const handler = vi.fn();
    hooks.on("SessionStart", handler);
    const agent = new Agent({
      modelClient: mockTextClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
    });
    agent.start("第一问");
    for await (const _ of agent.run()) {
      // 消费
    }
    agent.start("第二问");
    for await (const _ of agent.run()) {
      // 消费
    }

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("无工具调用时触发 Stop，本轮对话结束", async () => {
    const hooks = new HookBus();
    const handler = vi.fn();
    hooks.on("Stop", handler);
    const agent = new Agent({
      modelClient: mockTextClient("回答完毕"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
    });
    agent.start("问题");
    for await (const _ of agent.run()) {
      // 消费
    }

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("工具调用轮不触发 Stop，最终无工具调用的总结轮才触发一次", async () => {
    const hooks = new HookBus();
    const handler = vi.fn();
    hooks.on("Stop", handler);
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "read" };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "已读" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      tools: [
        {
          name: "read",
          description: "读取文件",
          inputSchema: z.object({}),
          isReadOnly: true,
          requiresUserInteraction: false,
          maxResultSizeChars: 1000,
          execute: () => "内容",
        },
      ],
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费
    }

    // 工具调用轮（第一轮）不触发；第二轮模型总结（无工具调用）触发一次
    expect(handler).toHaveBeenCalledTimes(1);
  });
});