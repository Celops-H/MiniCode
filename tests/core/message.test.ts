import { describe, expect, it } from "vitest";
import {
  assistantMessage,
  toolCallsOf,
  toolResultMessage,
  userMessage,
} from "../../src/core/index.js";
import type { ContentBlock, ToolCall } from "../../src/core/index.js";

describe("消息构造", () => {
  it("userMessage 构造用户输入", () => {
    expect(userMessage("你好")).toEqual({ role: "user", content: "你好" });
  });

  it("assistantMessage 构造模型回复（含元数据）", () => {
    const content: ContentBlock[] = [{ type: "text", text: "hi" }];
    expect(assistantMessage(content, { model: "deepseek", stopReason: "end_turn" })).toEqual({
      role: "assistant",
      content,
      meta: { model: "deepseek", stopReason: "end_turn" },
    });
  });

  it("assistantMessage 无元数据时不带 meta 字段", () => {
    expect(assistantMessage([])).toEqual({ role: "assistant", content: [] });
  });

  it("toolResultMessage 构造工具结果（默认非错误）", () => {
    const msg = toolResultMessage("call_1", "ok", false, "2026-08-10T00:00:00.000Z");
    expect(msg).toEqual({
      role: "tool_result",
      toolCallId: "call_1",
      isError: false,
      content: "ok",
      timestamp: "2026-08-10T00:00:00.000Z",
    });
  });

  it("toolResultMessage 支持标记错误", () => {
    const msg = toolResultMessage("call_1", "Error: boom", true, "t");
    expect(msg.isError).toBe(true);
  });
});

describe("toolCallId 配对键", () => {
  it("toolResultMessage 通过 toolCallId 关联助手消息中的工具调用", () => {
    const call: ToolCall = { type: "tool_call", id: "call_9", name: "read", input: { path: "a.ts" } };
    const assistant = assistantMessage([call]);
    const result = toolResultMessage(call.id, "内容");

    expect(toolCallsOf(assistant)[0]?.id).toBe("call_9");
    expect(result.toolCallId).toBe("call_9");
  });

  it("toolCallsOf 只提取工具调用，忽略文本与思考块", () => {
    const assistant = assistantMessage([
      { type: "text", text: "思考中" },
      { type: "thinking", thinking: "内部推理" },
      { type: "tool_call", id: "call_1", name: "glob", input: { pattern: "**/*.ts" } },
    ]);
    const calls = toolCallsOf(assistant);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "glob",
      input: { pattern: "**/*.ts" },
    });
  });
});
