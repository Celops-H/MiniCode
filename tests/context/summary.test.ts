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
  it("包含六段结构化摘要格式与禁工具调用的前言", () => {
    const request = buildSummaryRequest();
    expect(request.role).toBe("user");
    const content = (request as { content: string }).content;
    expect(content).toContain("不要调用任何工具");
    expect(content).toContain("1. 目标");
    expect(content).toContain("2. 约束");
    expect(content).toContain("3. 进展");
    expect(content).toContain("4. 决策");
    expect(content).toContain("5. 下一步");
    expect(content).toContain("6. 关键上下文");
  });

  it("无指导时不含 Additional Instructions 段", () => {
    const content = (buildSummaryRequest() as { content: string }).content;
    expect(content).not.toContain("Additional Instructions");
  });

  it("压缩指导以 Additional Instructions 段追加在提示词最末（DESIGN 9.8）", () => {
    const content = (buildSummaryRequest("侧重保留命令与输出") as { content: string }).content;
    const idx = content.indexOf("Additional Instructions：\n侧重保留命令与输出");
    expect(idx).toBeGreaterThan(0);
    // 尾部追加：指导段之后不再有其他小节
    expect(content.endsWith("Additional Instructions：\n侧重保留命令与输出")).toBe(true);
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
  it("替换为单条摘要用户消息并标记系统来源", () => {
    const replaced = replaceWithSummary("目标是重构");
    expect(replaced).toEqual([
      {
        role: "user",
        id: expect.any(String),
        content: "【会话摘要】\n目标是重构",
        source: "system",
        timestamp: expect.any(String),
      },
    ]);
  });
});
