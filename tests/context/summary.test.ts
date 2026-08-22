import { describe, expect, it } from "vitest";
import { buildSummaryRequest, generateSummary, replaceWithSummary } from "../../src/context/index.js";
import { userMessage } from "../../src/core/index.js";
import type { Summarizer } from "../../src/context/index.js";

/** 固定输出摘要文本的 mock 模型流 */
function mockSummarizer(text: string): Summarizer {
  return {
    async *stream() {
      yield { type: "text_delta", text };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

describe("buildSummaryRequest（摘要请求）", () => {
  it("包含六段结构化摘要格式与标题", () => {
    const request = buildSummaryRequest();
    expect(request.role).toBe("user");
    const content = (request as { content: string }).content;
    expect(content).toContain("1. 目标");
    expect(content).toContain("2. 约束");
    expect(content).toContain("3. 进展");
    expect(content).toContain("4. 决策");
    expect(content).toContain("5. 下一步");
    expect(content).toContain("6. 关键上下文");
  });

  it("附加注意点拼入请求", () => {
    const request = buildSummaryRequest("用户偏好简洁回答");
    expect((request as { content: string }).content).toContain("用户偏好简洁回答");
  });
});

describe("generateSummary（生成摘要）", () => {
  it("收集模型文本输出为摘要", async () => {
    const messages = [userMessage("你好"), userMessage("帮我写个工具")];
    const summary = await generateSummary(mockSummarizer("目标是写工具"), "mock", messages);
    expect(summary).toBe("目标是写工具");
  });

  it("摘要请求附带对话与空工具列表", async () => {
    let seen: { modelId: string; context: { messages: unknown[]; tools: unknown[] } } | undefined;
    const stream: Summarizer = {
      async *stream(modelId, context) {
        seen = { modelId, context };
        yield { type: "text_delta", text: "摘要" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const messages = [userMessage("问题")];
    await generateSummary(stream, "mock-model", messages);

    expect(seen?.modelId).toBe("mock-model");
    expect(seen?.context.tools).toEqual([]);
    // 对话消息 + 摘要请求
    expect(seen?.context.messages).toHaveLength(2);
  });

  it("模型无文本输出时返回空串", async () => {
    const stream: Summarizer = {
      async *stream() {
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    expect(await generateSummary(stream, "mock", [])).toBe("");
  });
});

describe("replaceWithSummary（摘要替换）", () => {
  it("替换为单条摘要用户消息", () => {
    const replaced = replaceWithSummary("目标是重构");
    expect(replaced).toEqual([
      { role: "user", id: expect.any(String), content: "【会话摘要】\n目标是重构" },
    ]);
  });
});
