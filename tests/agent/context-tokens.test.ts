/**
 * 水位口径（contextTokens）：API 真实 usage.promptTokens 回填优先，
 * 其后追加的消息按估算补增量；历史被改写（压缩/裁剪/清盘）后作废回估算。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import type { Context, StreamEvent } from "../../src/core/index.js";
import type { Tool } from "../../src/tools/index.js";

/** 记录每次调用收到的 context，按脚本产出事件 */
function scriptedClient(script: Array<(context: Context) => StreamEvent[]>): {
  client: ModelClient;
  contexts: Context[];
} {
  const contexts: Context[] = [];
  let call = 0;
  return {
    contexts,
    client: {
      async *stream(_modelId: string, context: Context) {
        contexts.push(context);
        for (const event of (script[call++] ?? (() => []))(context)) {
          yield event;
        }
      },
    },
  };
}

describe("contextTokens（水位口径）", () => {
  it("无真实用量时按估算（消息 + 系统提示词）", () => {
    const agent = new Agent({
      modelClient: { async *stream() {} } as unknown as ModelClient,
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
    });
    expect(agent.contextTokens()).toBe(agent.estimateContextTokens());
  });

  it("done 带真实用量即回填：水位=真实值，其后追加的消息按估算补增量", async () => {
    const { client, contexts } = scriptedClient([
      () => [
        { type: "text_delta", text: "回复" },
        { type: "done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, promptTokens: 1000 } },
      ],
    ]);
    const agent = new Agent({ modelClient: client, modelId: "mock", systemPrompt: "助手" });
    agent.start("你好");
    for await (const _ of agent.run()) {
      // 消费事件流
    }
    // 回复后的 assistant 消息已追加：水位 = 真实 1000 + 追加消息的估算增量
    const appended = agent.getMessages().filter((_, i) => i >= contexts[0]!.messages.length);
    expect(agent.contextTokens()).toBeGreaterThan(1000);
    expect(agent.contextTokens()).toBeLessThan(1100);
    expect(appended.length).toBeGreaterThan(0);
  });

  it("resetHistory 作废回填：清盘后水位回估算", async () => {
    const { client } = scriptedClient([
      () => [{ type: "done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, promptTokens: 100_000 } }],
    ]);
    const agent = new Agent({ modelClient: client, modelId: "mock", systemPrompt: "助手" });
    agent.start("你好");
    for await (const _ of agent.run()) {
      // 消费事件流
    }
    expect(agent.contextTokens()).toBeGreaterThanOrEqual(100_000);
    agent.resetHistory();
    expect(agent.contextTokens()).toBe(agent.estimateContextTokens());
    expect(agent.contextTokens()).toBeLessThan(100);
  });

  it("压缩改写历史后作废回填：不会拿压缩前的占用立即再触发压缩", async () => {
    const echoTool: Tool = {
      name: "echo",
      description: "回显",
      inputSchema: z.object({ text: z.string() }),
      isReadOnly: false,
      maxResultSizeChars: 1000,
      execute: (input) => `回显：${(input as { text: string }).text}`,
    };
    let call = 0;
    const client: ModelClient = {
      async *stream(_modelId: string, context: Context) {
        call++;
        if (call === 1) {
          // 第一轮：报告超大占用（模拟真实 usage），随后要求调工具
          yield { type: "toolcall_start", index: 0, id: "call_1", name: "echo" };
          yield { type: "toolcall_delta", index: 0, partialJson: '{"text":"hi"}' };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 5, promptTokens: 95_000 } };
          return;
        }
        // 摘要调用（压缩时 generateSummary 复用同一 client）：给一段可用的摘要文本
        const last = context.messages.at(-1);
        if (last?.role === "user" && typeof last.content === "string" && last.content.includes("压缩调用")) {
          yield { type: "text_delta", text: "目标：演示压缩" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        // 第二轮正常收尾（不回填超大占用）
        yield { type: "text_delta", text: "第二轮回复" };
        yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, promptTokens: 50 } };
      },
    };
    const agent = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      tools: [echoTool],
      compactConfig: { contextWindow: 100_000, maxOutputTokens: 8_192, safetyMargin: 4_096, keepRecentToolResults: 5 },
    });
    agent.start("你好");
    for await (const _ of agent.run()) {
      // 消费事件流：第一轮工具执行后第二轮撞线压缩（95k > 100k-12288 可用线）
    }
    // 压缩发生：历史被摘要替换
    const first = agent.getMessages()[0];
    expect(first?.role === "user" && first.content.startsWith("【会话摘要】")).toBe(true);
    // 回填已作废重记（第二轮真实用量 50 起步）：水位远低于压缩前的 95k 口径，
    // 不会被压缩前的占用立即再触发压缩
    expect(agent.contextTokens()).toBeLessThan(1000);
  });
});
