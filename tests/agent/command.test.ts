import { describe, expect, it } from "vitest";
import { Agent, type ModelClient } from "../../src/agent/index.js";
import { COMMAND_MARKER, userMessage } from "../../src/core/index.js";

describe("appendCommand（命令痕迹，E24）", () => {
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
});
