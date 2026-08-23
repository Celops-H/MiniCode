import { describe, expect, it } from "vitest";
import { buildRecoveryText, extractRecoveryContext } from "../../src/context/index.js";
import { assistantMessage, toolResultMessage, userMessage, type Message } from "../../src/core/index.js";

function toolCall(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_call" as const, id, name, input };
}

describe("extractRecoveryContext（恢复上下文提取）", () => {
  it("提取最近操作文件（read/write/edit 的 path，去重）", () => {
    const messages: Message[] = [
      assistantMessage([toolCall("c1", "read", { path: "a.ts" })]),
      toolResultMessage("c1", "read", "内容"),
      assistantMessage([toolCall("c2", "write", { path: "b.ts" })]),
      toolResultMessage("c2", "write", "已写入"),
      assistantMessage([toolCall("c3", "read", { path: "a.ts" })], { model: "mock" }),
      toolResultMessage("c3", "read", "内容"),
    ];
    // 逆序去重：a.ts（c3）→ b.ts（c2），a.ts 重复跳过
    expect(extractRecoveryContext(messages).files).toEqual(["a.ts", "b.ts"]);
  });

  it("忽略非文件工具（bash/grep 不提取 path）", () => {
    const messages: Message[] = [
      assistantMessage([
        toolCall("c1", "bash", { command: "ls" }),
        toolCall("c2", "grep", { pattern: "x" }),
      ]),
    ];
    expect(extractRecoveryContext(messages).files).toEqual([]);
  });

  it("提取最近用户请求（逆序取 N 条）与会话起始", () => {
    const messages: Message[] = [
      userMessage("开始"),
      userMessage("改一下"),
      userMessage("继续开发"),
      assistantMessage([{ type: "text", text: "好" }]),
    ];
    const context = extractRecoveryContext(messages, { maxRequests: 2 });
    expect(context.recentRequests).toEqual(["继续开发", "改一下"]);
    expect(context.sessionStart).toBe("开始");
  });

  it("无用户消息时 sessionStart 为空", () => {
    const messages: Message[] = [
      assistantMessage([{ type: "text", text: "hi" }]),
      toolResultMessage("c1", "read", "结果"),
    ];
    const context = extractRecoveryContext(messages);
    expect(context.sessionStart).toBeUndefined();
    expect(context.recentRequests).toEqual([]);
  });

  it("系统注入消息（摘要/恢复上下文）不计入用户请求与会话起始", () => {
    const messages: Message[] = [
      userMessage("【会话摘要】旧对话总结", "system"),
      userMessage("【恢复上下文】最近文件 a.ts", "system"),
      userMessage("真实的用户请求"),
      assistantMessage([{ type: "text", text: "好" }]),
    ];
    const context = extractRecoveryContext(messages);
    expect(context.recentRequests).toEqual(["真实的用户请求"]);
    expect(context.sessionStart).toBe("真实的用户请求");
  });
});

describe("buildRecoveryText（恢复文本）", () => {
  it("仅输出非空部分，换行连接", () => {
    const text = buildRecoveryText({
      files: ["a.ts", "b.ts"],
      recentRequests: ["继续开发"],
      sessionStart: "开始",
    });
    expect(text).toBe("最近操作文件：a.ts、b.ts\n活跃任务：继续开发\n会话起始：开始");
  });

  it("全部为空时返回空串", () => {
    expect(buildRecoveryText({ files: [], recentRequests: [] })).toBe("");
  });
});
