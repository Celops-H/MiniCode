import { describe, expect, it } from "vitest";
import { Agent, type ModelClient } from "../../src/agent/index.js";
import { COMMAND_MARKER, userMessage, type Context, type StreamEvent } from "../../src/core/index.js";

describe("appendCommand（命令痕迹）", () => {
  it("追加 source=command 的用户消息，带命令标记前缀", () => {
    const agent = new Agent({
      modelClient: { async *stream() {} } as unknown as ModelClient,
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
    });
    agent.appendCommand("/compact 侧重保留命令输出");
    const messages = agent.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "user",
      source: "command",
      content: `${COMMAND_MARKER}/compact 侧重保留命令输出`,
    });
    // 对比：普通用户消息经 start 推入
    expect(userMessage("hi").role).toBe("user");
  });

  it("命令痕迹不回灌模型：请求消息视图剥掉命令消息，持久化历史保留（E112）", async () => {
    const contexts: Context[] = [];
    const client: ModelClient = {
      async *stream(_modelId: string, context: Context) {
        contexts.push(context);
        yield { type: "text_delta", text: "收到" };
        yield { type: "done", stopReason: "end_turn" } as StreamEvent;
      },
    };
    const agent = new Agent({ modelClient: client, modelId: "mock", systemPrompt: "助手", tools: [] });
    // /init 式时序：先落命令痕迹，再以真实输入开轮
    agent.appendCommand("/init");
    agent.start("请生成 AGENTS.md");
    for await (const _ of agent.run()) {
      // 消费事件流
    }
    // 持久化历史里痕迹在列（界面重演依赖）
    expect(agent.getMessages()[0]).toMatchObject({ source: "command", content: "【命令】/init" });
    // 回灌模型的请求里没有命令消息
    const sent = contexts[0]!.messages;
    expect(sent.some((m) => m.role === "user" && m.source === "command")).toBe(false);
    expect(sent.map((m) => (m.role === "user" ? m.content : m.role))).toEqual(["请生成 AGENTS.md"]);
  });
});
