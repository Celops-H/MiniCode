import { describe, expect, it } from "vitest";
import { Agent, type ModelClient } from "../../src/agent/index.js";
import { toolResultMessage, userMessage } from "../../src/core/index.js";
import { MEMORY_REQUEST_MARKER, buildMemoryUpdateRequest } from "../../src/context/index.js";

/** 判别一次模型调用是不是记忆更新请求 */
function isMemoryRequest(context: { messages: { role: string; content: unknown }[] }): boolean {
  return context.messages.some(
    (m) => typeof m.content === "string" && m.content.includes(MEMORY_REQUEST_MARKER),
  );
}

describe("会话记忆（DESIGN 9.7）", () => {
  it("每轮结束后增量维护记忆：模型收到当前记忆 + 最近对话", async () => {
    const memoryCalls: { hasCurrent: boolean; roles: string }[] = [];
    const client: ModelClient = {
      async *stream(_modelId, context) {
        if (isMemoryRequest(context)) {
          const current = context.messages.some((m) => typeof m.content === "string" && m.content.includes("当前记忆"));
          memoryCalls.push({ hasCurrent: current, roles: context.messages.map((m) => m.role).join(",") });
          yield { type: "text_delta", text: "目标：修复导出问题" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "text_delta", text: "好的" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const agent = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
      memory: true,
    });
    agent.start("修复导出问题");
    for await (const _ of agent.run()) {
      // 消费
    }
    await agent.whenMemorySettled();
    // 每轮 Stop 后记忆更新一次（后台异步，收尾后断言）
    expect(memoryCalls).toHaveLength(1);
    expect(memoryCalls[0]).toMatchObject({ hasCurrent: true });

    // 第二轮：记忆继续累积（更新请求带上一轮的记忆文本）
    agent.start("继续");
    for await (const _ of agent.run()) {
      // 消费
    }
    await agent.whenMemorySettled();
    expect(memoryCalls).toHaveLength(2);
  });

  it("记忆更新失败静默：不影响对话主流程", async () => {
    const client: ModelClient = {
      async *stream(_modelId, context) {
        if (isMemoryRequest(context)) throw new Error("记忆模型不可用");
        yield { type: "text_delta", text: "回复" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const agent = new Agent({ modelClient: client, modelId: "mock", systemPrompt: "助手", tools: [], memory: true });
    agent.start("你好");
    // 不抛错，正常完成
    await expect(async () => {
      for await (const _ of agent.run()) {
        // 消费
      }
    }).not.toThrow();
  });

  it("压缩时用记忆替代现场摘要：不调摘要模型，摘要消息 = 记忆内容", async () => {
    let summaryCalls = 0;
    const client: ModelClient = {
      async *stream(_modelId, context) {
        if (isMemoryRequest(context)) {
          yield { type: "text_delta", text: "记忆：用户想搭建脚手架" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        if (context.messages.some((m) => typeof m.content === "string" && m.content.includes("结构化摘要"))) {
          summaryCalls++;
          yield { type: "text_delta", text: "现场摘要" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "text_delta", text: "好的" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const agent = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
      memory: true,
      compactConfig: { contextWindow: 300, maxOutputTokens: 30, safetyMargin: 20, keepRecentToolResults: 1 },
    });
    // 第一轮：正常对话，Stop 后后台建立记忆（E40 异步：收尾后等待更新完成）
    agent.start("搭建脚手架");
    for await (const _ of agent.run()) {
      // 消费
    }
    await agent.whenMemorySettled();
    // 第二轮：大输入撞线压缩——摘要直接用记忆，不调现场摘要模型
    const longInput = "很长的问题".repeat(200);
    agent.start(longInput);
    for await (const _ of agent.run()) {
      // 消费
    }
    const messages = agent.getMessages();
    expect(messages[0]).toMatchObject({
      role: "user",
      source: "system",
      content: expect.stringContaining("【会话摘要】"),
    });
    expect(String(messages[0]?.content)).toContain("记忆：用户想搭建脚手架");
    // 在途内容不丢：触发压缩的用户输入保留原文（记忆只覆盖上次 Stop 前的历史）
    expect(messages.some((m) => typeof m.content === "string" && m.content === longInput)).toBe(true);
    // 未调用现场摘要模型
    expect(summaryCalls).toBe(0);
  });
});

describe("buildMemoryUpdateRequest", () => {
  it("请求含当前记忆与最近对话，消息数受 maxRecentMessages 限制", () => {
    const messages = Array.from({ length: 12 }, (_, i) => userMessage(`消息${i}`));
    const request = buildMemoryUpdateRequest({ currentMemory: "旧记忆", recentMessages: messages, maxRecentMessages: 5 });
    expect(request).toHaveLength(1);
    const text = String(request[0]!.content);
    expect(text).toContain("旧记忆");
    expect(text).toContain("消息7"); // 最近 5 条：8~12 → 消息7 在（0-indexed 消息7 = 第 8 条）
    expect(text).not.toContain("消息0");
  });

  it("单条消息内容截断（工具结果巨大时控制调用体积）", () => {
    const request = buildMemoryUpdateRequest({
      currentMemory: "",
      recentMessages: [toolResultMessage("c1", "read", "x".repeat(5000), false)],
    });
    const text = String(request[0]!.content);
    expect(text).toContain("x".repeat(2000));
    expect(text).not.toContain("x".repeat(2001));
    expect(text).toMatch(/…$/);
  });
});
describe("记忆更新后台化（E40）", () => {
  it("回合收尾不再被记忆更新阻塞：run() 先于记忆请求完成返回", async () => {
    let releaseMemory: (() => void) | undefined;
    let turnDone = false;
    const client: ModelClient = {
      async *stream(_modelId, context) {
        if (isMemoryRequest(context)) {
          // 挂住后台记忆更新，直到断言完成
          await new Promise<void>((resolve) => (releaseMemory = resolve));
          yield { type: "text_delta", text: "记忆" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "text_delta", text: "回复" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const agent = new Agent({ modelClient: client, modelId: "mock", systemPrompt: "助手", tools: [], memory: true });
    agent.start("你好");
    for await (const _ of agent.run()) {
      // 消费
    }
    turnDone = true;
    // 回合已结束而后台记忆更新仍被挂起：fire-and-forget 生效
    expect(turnDone).toBe(true);
    expect(isMemoryRequest({ messages: [] })).toBe(false);
    releaseMemory?.();
    await agent.whenMemorySettled();
  });

  it("跑动中多次触发合并为尾随一次：不叠加排队调用", async () => {
    let memoryCalls = 0;
    let notifyStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => (notifyStarted = resolve));
    const client: ModelClient = {
      async *stream(_modelId, context) {
        if (isMemoryRequest(context)) {
          memoryCalls++;
          if (memoryCalls === 1) {
            // 通知测试第一次更新已开跑（跑动中），随后挂 20ms 供后续收尾触发进来合并
            notifyStarted?.();
            await new Promise<void>((r) => setTimeout(r, 20));
          }
          yield { type: "text_delta", text: "记忆" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "text_delta", text: "回复" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const agent = new Agent({ modelClient: client, modelId: "mock", systemPrompt: "助手", tools: [], memory: true });
    agent.start("第一轮");
    for await (const _ of agent.run()) {
      // 消费
    }
    await firstStarted;
    // 第一次更新跑动中再收两轮尾：第二次触发排队、第三次被合并（queued 已置位）
    agent.start("第二轮");
    for await (const _ of agent.run()) {
      // 消费
    }
    agent.start("第三轮");
    for await (const _ of agent.run()) {
      // 消费
    }
    await agent.whenMemorySettled();
    // 第一次 + 尾随一次 = 恰好 2 次：跑动中的两次收尾没有各自叠加成两次调用
    expect(memoryCalls).toBe(2);
  });
});
