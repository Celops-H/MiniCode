import { describe, expect, it } from "vitest";
import { userMessage, assistantMessage, toolResultMessage, type Message } from "../../src/core/index.js";
import { isContextTooLongError, parseContextTooLongGap, peelToolGroups } from "../../src/context/index.js";

/** 构造含工具调用的 assistant 消息 */
function assistantWithToolCall(id: string, name = "read"): ReturnType<typeof assistantMessage> {
  return assistantMessage([{ type: "tool_call", id, name, input: { path: `/tmp/${id}.txt` } }]);
}

/** 构造工具回合（assistant 调用 + tool_result 配对） */
function toolRound(id: string, result = "内容 ".repeat(20)): Message[] {
  return [assistantWithToolCall(id), toolResultMessage(id, "read", result, false)];
}

/** 断言消息数组的内容结构（消息 id 随机，逐条比较 role 与 content） */
function expectSameShape(actual: Message[] | null, expected: Message[]): void {
  expect(actual?.map((m) => ({ role: m.role, content: m.content }))).toEqual(
    expected.map((m) => ({ role: m.role, content: m.content })),
  );
}

describe("isContextTooLongError", () => {
  it("各家超窗错误形态都识别", () => {
    // Anthropic
    expect(isContextTooLongError(new Error("prompt is too long: 137500 tokens > 135000 maximum"))).toBe(true);
    // OpenAI
    expect(
      isContextTooLongError(
        new Error("This model's maximum context length is 128000 tokens. However, you requested 137500 tokens"),
      ),
    ).toBe(true);
    // 413 状态（Vertex/Bedrock）
    expect(isContextTooLongError({ status: 413, message: "Request Too Large" })).toBe(true);
    // 大小写不敏感
    expect(isContextTooLongError(new Error("Prompt is too long"))).toBe(true);
  });

  it("非超窗错误不误判", () => {
    expect(isContextTooLongError(new Error("401 Invalid API key"))).toBe(false);
    expect(isContextTooLongError({ status: 429, message: "rate limit" })).toBe(false);
    expect(isContextTooLongError(undefined)).toBe(false);
  });
});

describe("parseContextTooLongGap", () => {
  it("Anthropic 格式：actual 在前，gap = actual - limit", () => {
    expect(parseContextTooLongGap(new Error("prompt is too long: 137500 tokens > 135000 maximum"))).toBe(2500);
  });

  it("OpenAI 格式：limit 在前，gap = actual - limit", () => {
    expect(
      parseContextTooLongGap(
        new Error("This model's maximum context length is 128000 tokens. However, you requested 137500 tokens"),
      ),
    ).toBe(9500);
  });

  it("无法解析或未超出时返回 undefined", () => {
    expect(parseContextTooLongGap(new Error("prompt is too long"))).toBeUndefined();
    expect(parseContextTooLongGap(new Error("prompt is too long: 100 tokens > 200 maximum"))).toBeUndefined();
    expect(parseContextTooLongGap(new Error("磁盘满了"))).toBeUndefined();
  });
});

describe("peelToolGroups", () => {
  it("剥掉最近一组工具回合，配对不拆；游离总结文本保留", () => {
    const messages = [
      userMessage("开始"),
      assistantMessage([{ type: "text", text: "读一下" }]),
      ...toolRound("r1"),
      assistantMessage([{ type: "text", text: "总结" }]),
    ];
    const peeled = peelToolGroups(messages);
    expect(peeled).not.toBeNull();
    expectSameShape(peeled, [
      userMessage("开始"),
      assistantMessage([{ type: "text", text: "读一下" }]),
      assistantMessage([{ type: "text", text: "总结" }]),
    ]);
  });

  it("并行调用同组剥离（assistant 多个 tool_call 与其 tool_result 一起）", () => {
    const messages = [
      userMessage("开始"),
      assistantMessage([
        { type: "tool_call", id: "a", name: "read", input: {} },
        { type: "tool_call", id: "b", name: "read", input: {} },
      ]),
      toolResultMessage("a", "read", "A", false),
      toolResultMessage("b", "read", "B", false),
      assistantMessage([{ type: "text", text: "总结" }]),
    ];
    const peeled = peelToolGroups(messages);
    // 游离的总结消息不属于工具组，剥离后保留
    expectSameShape(peeled, [userMessage("开始"), assistantMessage([{ type: "text", text: "总结" }])]);
  });

  it("按 gap 剥多组：累计估算 token 覆盖缺口", () => {
    // 每组约 19 token（工具调用 + 30 字结果）；gap=50 需剥 3 组才覆盖，两组剥光剩开头
    const messages = [
      userMessage("开始"),
      ...toolRound("r1", "x".repeat(30)),
      ...toolRound("r2", "x".repeat(30)),
      assistantMessage([{ type: "text", text: "总结" }]),
    ];
    const peeled = peelToolGroups(messages, 50);
    expectSameShape(peeled, [userMessage("开始"), assistantMessage([{ type: "text", text: "总结" }])]);
  });

  it("gap 很小也至少剥一组；无工具组可剥返回 null", () => {
    const withOneGroup = [userMessage("开始"), ...toolRound("r1"), assistantMessage([{ type: "text", text: "总结" }])];
    expectSameShape(peelToolGroups(withOneGroup, 1), [
      userMessage("开始"),
      assistantMessage([{ type: "text", text: "总结" }]),
    ]);

    const noGroups = [userMessage("开始"), assistantMessage([{ type: "text", text: "无工具" }])];
    expect(peelToolGroups(noGroups)).toBeNull();
  });

  it("剥离不误伤组间的游离消息（如后续轮次的用户输入）", () => {
    // 第二轮 user 输入夹在两组工具回合之间，剥离最近一组时它必须保留
    const messages = [
      userMessage("第一轮"),
      ...toolRound("r1"),
      userMessage("第二轮输入"),
      ...toolRound("r2"),
    ];
    const peeled = peelToolGroups(messages);
    expectSameShape(peeled, [
      userMessage("第一轮"),
      ...toolRound("r1"),
      userMessage("第二轮输入"),
    ]);
  });

  it("剥光全部组仍保留第一条，不为空", () => {
    const messages = [userMessage("开始"), ...toolRound("r1")];
    const peeled = peelToolGroups(messages);
    expectSameShape(peeled, [userMessage("开始")]);
  });
});

