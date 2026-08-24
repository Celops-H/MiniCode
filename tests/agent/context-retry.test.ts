import { describe, expect, it } from "vitest";
import { Agent, type ModelClient } from "../../src/agent/index.js";
import { assistantMessage, toolResultMessage, userMessage, type Message } from "../../src/core/index.js";

/** 超窗错误：第一次 stream 抛 Anthropic 格式超窗，之后正常返回文本 */
function contextTooLongThenTextClient(): ModelClient {
  let calls = 0;
  return {
    async *stream(_modelId, context) {
      calls++;
      if (calls === 1) {
        throw new Error("prompt is too long: 137500 tokens > 135000 maximum");
      }
      yield { type: "text_delta", text: `重发成功（第 ${calls} 次）` };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

describe("应急剥组重发（DESIGN 9.6）", () => {
  it("超窗错误：剥掉最近工具回合后重发当前轮，模型拿到剥后上下文", async () => {
    // 历史里有一组工具回合：assistant(toolcall) + tool_result
    const initial: Message[] = [
      userMessage("读文件"),
      assistantMessage([{ type: "tool_call", id: "r1", name: "read", input: { path: "/tmp/a.txt" } }]),
      toolResultMessage("r1", "read", "内容", false),
    ];
    let seenContexts: Message[][] = [];
    let calls = 0;
    const client: ModelClient = {
      async *stream(_modelId, context) {
        calls++;
        seenContexts.push([...context.messages]); // 拷贝：context 持有内部数组引用，断言时点会漂移
        if (calls === 1) {
          throw new Error("prompt is too long: 137500 tokens > 135000 maximum");
        }
        yield { type: "text_delta", text: "总结" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const agent = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      initialMessages: initial,
    });
    agent.start("继续");
    const events = [];
    for await (const e of agent.run()) events.push(e);

    expect(calls).toBe(2);
    // 重发时上下文已剥掉工具回合：尾部不再有 tool_result，当前轮输入保留
    const retried = seenContexts[1]!;
    expect(retried.some((m) => m.role === "tool_result")).toBe(false);
    expect(retried.map((m) => m.role)).toEqual(["user", "user"]);
    // 主循环正常结束（剥组不打断当前轮）
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    // 剥组后的上下文与内部消息同步（后续轮次不回退到被剥的消息）
    expect(agent.getMessages().some((m) => m.role === "tool_result")).toBe(false);
  });

it("连续超窗：重试上限后直接报错，且恢复剥前消息（失败不留副作用）", async () => {
    const client: ModelClient = {
      async *stream() {
        throw new Error("prompt is too long: 100000 tokens > 90000 maximum");
      },
    };
    const agent = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      initialMessages: [userMessage("开始"), ...makeToolRound()],
    });
    agent.start("继续");
    await expect(async () => {
      for await (const _ of agent.run()) {
        // 消费
      }
    }).rejects.toThrow("prompt is too long");
    // 重试耗尽后消息回到剥前状态（工具回合未被剥掉）
    expect(agent.getMessages().some((m) => m.role === "tool_result")).toBe(true);
  });
});

/** 构造一组工具回合（assistant 调用 + tool_result 配对） */
function makeToolRound(): Message[] {
  return [
    assistantMessage([{ type: "tool_call", id: "x1", name: "read", input: {} }]),
    toolResultMessage("x1", "read", "内容", false),
  ];
}

