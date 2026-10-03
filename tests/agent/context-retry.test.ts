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

describe("应急剥组重发", () => {
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

describe("历史改写后组装剥 thinking 块", () => {
  /** 早期工具回合：assistant 带思考块 + tool_result（剥最近一组后仍留在历史里） */
  const initial: Message[] = [
    userMessage("先看看"),
    assistantMessage([
      { type: "thinking", thinking: "早期思考" },
      { type: "tool_call", id: "r0", name: "read", input: {} },
    ]),
    toolResultMessage("r0", "read", "旧内容", false),
    userMessage("读文件"),
    ...makeToolRound(),
  ];

  interface SeenRequest {
    messages: Message[];
    thinkingLevel: string | undefined;
  }

  function stripAwareClient(seenRequests: SeenRequest[]): ModelClient {
    let calls = 0;
    return {
      async *stream(_modelId, context) {
        calls++;
        // 拷贝：context 持有内部数组引用，断言时点会漂移
        seenRequests.push({ messages: [...context.messages], thinkingLevel: context.thinkingLevel });
        if (calls === 1) {
          // 命中超窗判定但不带可解析缺口数字：按「剥最近一组」重试，早期工具回合（含思考块）保留
          throw new Error("prompt is too long");
        }
        yield { type: "text_delta", text: `第 ${calls} 次回复` };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
  }

  it("剥组重试的请求剥掉 thinking 块（工具调用与结果保留），内部历史不动", async () => {
    const seenRequests: SeenRequest[] = [];
    const agent = new Agent({
      modelClient: stripAwareClient(seenRequests),
      modelId: "mock",
      systemPrompt: "助手",
      thinkingLevelRef: () => "high",
      initialMessages: initial,
    });
    agent.start("继续");
    for await (const _ of agent.run()) {
      // 消费
    }
    expect(seenRequests.length).toBe(2);
    // 首次请求：thinking 块在、思考等级照常
    expect(seenRequests[0]!.messages.some((m) => m.role === "assistant")).toBe(true);
    expect(seenRequests[0]!.thinkingLevel).toBe("high");
    // 重发请求：thinking 块被剥掉，同一条 assistant 的工具调用保留；
    // 思考等级一并撤下（严格校验端点要求带 thinking 参数的请求以 thinking 块开头，剥块后照发会反复 400）
    const retried = seenRequests[1]!;
    const early = retried.messages.find((m) => m.role === "assistant")!;
    expect(early.content.some((b) => b.type === "thinking")).toBe(false);
    expect(early.content.some((b) => b.type === "tool_call")).toBe(true);
    expect(retried.thinkingLevel).toBeUndefined();
    // 剥块只影响请求视图：内部历史仍保留思考块（未改写场景同模型要带签名回传）
    const internal = agent.getMessages().find((m) => m.role === "assistant")!;
    expect(internal.content.some((b) => b.type === "thinking")).toBe(true);
  });

  it("改写标记被宿主消费复位后，下一轮请求恢复回传 thinking 块与思考等级", async () => {
    const seenRequests: SeenRequest[] = [];
    const agent = new Agent({
      modelClient: stripAwareClient(seenRequests),
      modelId: "mock",
      systemPrompt: "助手",
      thinkingLevelRef: () => "high",
      initialMessages: initial,
    });
    agent.start("继续");
    for await (const _ of agent.run()) {
      // 消费
    }
    expect(agent.consumeHistoryRewritten()).toBe(true); // 宿主轮末消费（复位标记）
    agent.start("再继续");
    for await (const _ of agent.run()) {
      // 消费
    }
    const next = seenRequests[2]!;
    const early = next.messages.find((m) => m.role === "assistant")!;
    expect(early.content.some((b) => b.type === "thinking")).toBe(true);
    expect(next.thinkingLevel).toBe("high");
  });
});

