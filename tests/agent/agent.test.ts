import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import { PRUNED_MARKER } from "../../src/context/index.js";
import { assistantMessage, toolResultMessage, userMessage, type Message, type UserMessage } from "../../src/core/index.js";
import { PermissionPipeline, parseRuleString } from "../../src/permission/index.js";
import type { StreamEvent } from "../../src/core/index.js";
import type { Tool } from "../../src/tools/index.js";

function mockTextClient(...texts: string[]): ModelClient {
  return {
    async *stream() {
      for (const t of texts) yield { type: "text_delta", text: t };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

describe("Agent 主循环：模型对话闭环", () => {
  it("文本对话：调模型 → 拼装回复 → 无工具调用结束", async () => {
    const agent = new Agent({
      modelClient: mockTextClient("你好", "呀"),
      modelId: "mock",
      systemPrompt: "你是一个助手",
    });
    agent.start("你好");
    const events: StreamEvent[] = [];
    for await (const e of agent.run()) events.push(e);

    const messages = agent.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", id: expect.any(String), content: "你好" });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "你好呀" }],
    });
    // run 透传了模型流事件（含 done）
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });

  it("多轮对话：消息按轮次累积", async () => {
    const agent = new Agent({
      modelClient: mockTextClient("第一轮回复"),
      modelId: "mock",
      systemPrompt: "助手",
    });
    agent.start("第一个问题");
    for await (const _ of agent.run()) {
      // 消费事件流
    }
    agent.start("第二个问题");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const messages = agent.getMessages();
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: "user", id: expect.any(String), content: "第一个问题" });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "第一轮回复" }],
    });
    expect(messages[2]).toEqual({ role: "user", id: expect.any(String), content: "第二个问题" });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "第一轮回复" }],
    });
  });

  it("start 重置 turnCount：每轮用户输入独立受 maxTurns 限制", async () => {
    const agent = new Agent({
      modelClient: mockTextClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      maxTurns: 1,
    });
    agent.start("第一个问题");
    for await (const _ of agent.run()) {
      // 消费事件流
    }
    const events: StreamEvent[] = [];
    agent.start("第二个问题");
    for await (const e of agent.run()) events.push(e);

    // 修复回归：turnCount 不重置会累计到 maxTurns，第二轮输入静默无响应
    expect(events.length).toBeGreaterThan(0);
    expect(agent.getMessages()).toHaveLength(4);
  });

  it("runTurn 按 turn 粒度执行：工具调用一轮暂停，再调用继续，Stop 后无事件", async () => {
    const echoTool: Tool = {
      name: "echo",
      description: "回显文本",
      inputSchema: z.object({ text: z.string() }),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: (input) => `回显：${(input as { text: string }).text}`,
    };
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasToolResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasToolResult) {
            yield { type: "toolcall_start", index: 0, id: "call_1", name: "echo" };
            yield { type: "toolcall_delta", index: 0, partialJson: '{"text":"hi"}' };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "工具已执行" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [echoTool],
    });
    agent.start("说 hi");

    // 第一轮：模型请求工具，执行后回灌；事件含工具调用
    const turn1: StreamEvent[] = [];
    for await (const e of agent.runTurn()) turn1.push(e);
    expect(turn1.some((e) => e.type === "toolcall_start")).toBe(true);
    expect(agent.getMessages()).toHaveLength(3); // user + assistant(tool_call) + tool_result

    // 第二轮：模型看到结果后文本结束（Stop）
    const turn2: StreamEvent[] = [];
    for await (const e of agent.runTurn()) turn2.push(e);
    expect(turn2.some((e) => e.type === "text_delta")).toBe(true);
    expect(agent.getMessages()).toHaveLength(4);

    // Stop 之后：不再产生任何事件
    const turn3: StreamEvent[] = [];
    for await (const e of agent.runTurn()) turn3.push(e);
    expect(turn3).toHaveLength(0);
  });

  it("未知工具调用回灌为错误消息，模型据此继续", async () => {
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasToolResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasToolResult) {
            yield {
              type: "toolcall_start",
              index: 0,
              id: "call_1",
              name: "read",
            };
            yield { type: "toolcall_delta", index: 0, partialJson: '{"path":"a.ts"}' };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "明白了" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const messages = agent.getMessages();
    // user → assistant(工具调用) → tool_result(未知工具错误) → assistant(继续)
    expect(messages).toHaveLength(4);
    expect(messages[1]).toMatchObject({
      content: [{ type: "tool_call", id: "call_1", name: "read", input: { path: "a.ts" } }],
    });
    expect(messages[2]).toMatchObject({
      role: "tool_result",
      toolCallId: "call_1",
      isError: true,
      content: expect.stringContaining("未知工具"),
    });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "明白了" }],
    });
  });

  it("并发安全工具并行执行，结果按声明顺序回灌", async () => {
    const events: string[] = [];
    const mkTool = (name: string) => {
      const tool: Tool = {
        name,
        description: `只读工具 ${name}`,
        inputSchema: z.object({}),
        isReadOnly: true,
        requiresUserInteraction: false,
        maxResultSizeChars: 1000,
        isConcurrencySafe: () => true,
        execute: async () => {
          events.push(`start${name}`);
          await new Promise((r) => setTimeout(r, 15));
          events.push(`end${name}`);
          return `${name}完成`;
        },
      };
      return tool;
    };
    const toolA = mkTool("readA");
    const toolB = mkTool("readB");

    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "readA" };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "toolcall_start", index: 1, id: "c2", name: "readB" };
            yield { type: "toolcall_end", index: 1 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "完成" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [toolA, toolB],
    });
    agent.start("并行读");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    // 两个工具都在批内并发：全部 start 先于全部 end
    const starts = events.filter((e) => e.startsWith("start")).sort();
    const ends = events.filter((e) => e.startsWith("end")).sort();
    expect(starts).toEqual(["startreadA", "startreadB"]);
    expect(ends).toEqual(["endreadA", "endreadB"]);
    expect(events.indexOf("endreadA")).toBeGreaterThan(events.indexOf("startreadB"));
    expect(events.indexOf("endreadB")).toBeGreaterThan(events.indexOf("startreadA"));

    // 工具结果按声明顺序回灌
    const messages = agent.getMessages();
    const results = messages.filter((m) => m.role === "tool_result");
    expect(results.map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
  });

  it("工具产出的上下文修改在整批结束后按声明顺序应用", async () => {
    const applied: string[] = [];
    const mkTool = (name: string) => {
      const tool: Tool = {
        name,
        description: `并发工具 ${name}`,
        inputSchema: z.object({}),
        isReadOnly: true,
        requiresUserInteraction: false,
        maxResultSizeChars: 1000,
        isConcurrencySafe: () => true,
        execute: () => ({
          output: `${name}完成`,
          contextModifier: () => applied.push(`mod${name}`),
        }),
      };
      return tool;
    };

    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "ctxA" };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "toolcall_start", index: 1, id: "c2", name: "ctxB" };
            yield { type: "toolcall_end", index: 1 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "完成" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [mkTool("ctxA"), mkTool("ctxB")],
    });
    agent.start("改上下文");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    // 上下文修改按工具声明顺序应用，而非执行完成顺序
    expect(applied).toEqual(["modctxA", "modctxB"]);
  });

  it("完整工具回合：模型请求工具 → 执行 → 结果回灌 → 模型继续", async () => {
    const echoTool: Tool = {
      name: "echo",
      description: "回显文本",
      inputSchema: z.object({ text: z.string() }),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: (input) => `回显：${(input as { text: string }).text}`,
    };
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasToolResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasToolResult) {
            yield { type: "toolcall_start", index: 0, id: "call_1", name: "echo" };
            yield { type: "toolcall_delta", index: 0, partialJson: '{"text":"hi"}' };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "工具已执行" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [echoTool],
    });
    agent.start("说 hi");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const messages = agent.getMessages();
    // user → assistant(工具调用) → tool_result → assistant(总结)
    expect(messages).toHaveLength(4);
    expect(messages[1]).toMatchObject({
      content: [{ type: "tool_call", id: "call_1", name: "echo" }],
    });
    expect(messages[2]).toMatchObject({
      role: "tool_result",
      toolCallId: "call_1",
      isError: false,
      content: "回显：hi",
    });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "工具已执行" }],
    });
  });

  it("工具输出超过上限时截断并加截断标记", async () => {
    const bigTool: Tool = {
      name: "big",
      description: "返回超长输出",
      inputSchema: z.object({}),
      isReadOnly: true,
      requiresUserInteraction: false,
      maxResultSizeChars: 10,
      execute: () => "一二三四五六七八九十十一十二十三十四十五",
    };
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "big" };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "完成" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [bigTool],
    });
    agent.start("大输出");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const messages = agent.getMessages();
    const result = messages.find((m) => m.role === "tool_result");
    expect(result).toMatchObject({
      role: "tool_result",
      toolCallId: "c1",
      isError: false,
      content: expect.stringContaining("[输出已截断：共 20 字符，保留前 10 字符]"),
    });
  });

  it("工具标记失败（isError）时回灌为错误消息", async () => {
    const failTool: Tool = {
      name: "fail",
      description: "标记失败的工具",
      inputSchema: z.object({}),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: () => ({ output: "执行超时，已终止", isError: true }),
    };
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "fail" };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "完成" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [failTool],
    });
    agent.start("失败工具");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const messages = agent.getMessages();
    const result = messages.find((m) => m.role === "tool_result");
    expect(result).toMatchObject({
      role: "tool_result",
      toolCallId: "c1",
      isError: true,
      content: "执行超时，已终止",
    });
  });

  it("非法参数回灌可读错误，不执行工具", async () => {
    let executed = false;
    const echoTool: Tool = {
      name: "echo",
      description: "回显文本",
      inputSchema: z.object({ text: z.string() }),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: () => {
        executed = true;
        return "不应执行";
      },
    };
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "echo" };
            yield { type: "toolcall_delta", index: 0, partialJson: '{"text":123}' };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "完成" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [echoTool],
    });
    agent.start("非法参数");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    expect(executed).toBe(false); // 校验失败未进执行
    const messages = agent.getMessages();
    const result = messages.find((m) => m.role === "tool_result");
    expect(result).toMatchObject({
      role: "tool_result",
      toolCallId: "c1",
      isError: true,
      content: expect.stringContaining("参数 text：Invalid input: expected string, received number"),
    });
  });

  it("未知工具提示可用工具", async () => {
    const echoTool: Tool = {
      name: "echo",
      description: "回显文本",
      inputSchema: z.object({ text: z.string() }),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: () => "回显",
    };
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "no_such_tool" };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "完成" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [echoTool],
    });
    agent.start("未知工具");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const messages = agent.getMessages();
    const result = messages.find((m) => m.role === "tool_result");
    expect(result).toMatchObject({
      role: "tool_result",
      toolCallId: "c1",
      isError: true,
      content: expect.stringContaining("未知工具：no_such_tool"),
    });
    expect(result?.content).toContain("可用工具：echo");
  });

  it("执行抛错回灌错误信息含工具名", async () => {
    const boomTool: Tool = {
      name: "boom",
      description: "执行即抛错",
      inputSchema: z.object({}),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: () => {
        throw new Error("磁盘写入失败");
      },
    };
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "boom" };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "完成" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [boomTool],
    });
    agent.start("执行失败");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const messages = agent.getMessages();
    const result = messages.find((m) => m.role === "tool_result");
    expect(result).toMatchObject({
      role: "tool_result",
      toolCallId: "c1",
      isError: true,
      content: "工具 boom 执行失败：磁盘写入失败",
    });
  });

  it("撞线时用 LLM 摘要替换旧对话", async () => {
    // 摘要调用（tools 为空）返回摘要文本；正常调用返回普通文本
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        if (context.tools.length === 0) {
          yield { type: "text_delta", text: "目标是压缩测试" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "text_delta", text: "正常回复" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const longHistory: Message[] = Array.from({ length: 20 }, (_, i) =>
      userMessage(`消息${i} `.repeat(50)),
    );
    const echoTool: Tool = {
      name: "echo",
      description: "回显",
      inputSchema: z.object({}),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: () => "回显",
    };
    const agent = new Agent({
      modelClient,
      modelId: "mock",
      systemPrompt: "助手",
      initialMessages: longHistory,
      tools: [echoTool], // 注册工具让正常调用 tools 非空，与摘要调用区分
      compactConfig: { contextWindow: 100, maxOutputTokens: 30, safetyMargin: 20, keepRecentToolResults: 1 },
    });
    agent.start("继续");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const messages = agent.getMessages();
    // 旧对话被压缩为摘要消息，之后正常对话
    expect(messages[0]).toMatchObject({
      role: "user",
      source: "system",
      content: expect.stringContaining("【会话摘要】"),
    });
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "正常回复" }],
    });
  });

  it("撞线时历史裁剪优先于摘要", async () => {
    let summaryCalled = false;
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        if (context.tools.length === 0) {
          summaryCalled = true;
          yield { type: "text_delta", text: "摘要" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "text_delta", text: "正常回复" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const longResults: Message[] = Array.from({ length: 10 }, (_, i) =>
      toolResultMessage(`c${i}`, "read", "x".repeat(100)),
    );
    const echoTool: Tool = {
      name: "echo",
      description: "回显",
      inputSchema: z.object({}),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: () => "回显",
    };
    const agent = new Agent({
      modelClient,
      modelId: "mock",
      systemPrompt: "助手",
      initialMessages: longResults,
      tools: [echoTool], // 注册工具让正常调用 tools 非空，与摘要调用区分
      // 全部裁剪后仅剩裁剪标记，估算低于可用窗口，不触发摘要
      compactConfig: { contextWindow: 100, maxOutputTokens: 30, safetyMargin: 20, keepRecentToolResults: 0 },
    });
    agent.start("继续");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    // 裁剪释放空间后未触发摘要；旧工具输出被替换为裁剪标记
    expect(summaryCalled).toBe(false);
    expect(agent.getMessages().some((m) => m.role === "tool_result" && m.content === PRUNED_MARKER)).toBe(true);
  });

  it("未撞线时不压缩", async () => {
    const agent = new Agent({
      modelClient: mockTextClient("正常回复"),
      modelId: "mock",
      systemPrompt: "助手",
      initialMessages: [userMessage("短消息")],
      compactConfig: { contextWindow: 10000, maxOutputTokens: 1000, safetyMargin: 500, keepRecentToolResults: 1 },
    });
    agent.start("继续");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const messages = agent.getMessages();
    expect(messages).toHaveLength(3); // 短消息 + 继续 + assistant
    expect(messages[0]).toEqual({ role: "user", id: expect.any(String), content: "短消息" });
  });

  it("压缩后注入恢复上下文（最近文件/活跃任务/会话起始）", async () => {
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        if (context.tools.length === 0) {
          yield { type: "text_delta", text: "目标是重构" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "text_delta", text: "正常回复" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const history: Message[] = [
      userMessage("会话开始：重构项目 ".repeat(20)),
      assistantMessage([{ type: "tool_call", id: "c1", name: "read", input: { path: "src/a.ts" } }]),
      toolResultMessage("c1", "read", "内容"),
      assistantMessage([{ type: "tool_call", id: "c2", name: "write", input: { path: "src/b.ts" } }]),
      toolResultMessage("c2", "write", "已写入"),
      userMessage("继续重构"),
    ];
    const echoTool: Tool = {
      name: "echo",
      description: "回显",
      inputSchema: z.object({}),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: () => "回显",
    };
    const agent = new Agent({
      modelClient,
      modelId: "mock",
      systemPrompt: "助手",
      initialMessages: history,
      tools: [echoTool],
      compactConfig: { contextWindow: 40, maxOutputTokens: 5, safetyMargin: 5, keepRecentToolResults: 1 },
    });
    agent.start("继续");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const messages = agent.getMessages();
    expect(messages[0]).toMatchObject({
      role: "user",
      source: "system",
      content: expect.stringContaining("【会话摘要】"),
    });
    // 摘要后注入恢复上下文：最近操作文件 + 活跃任务 + 会话起始
    const recovery = messages.find(
      (m): m is UserMessage => m.role === "user" && m.content.startsWith("【恢复上下文】"),
    );
    expect(recovery).toBeDefined();
    // 恢复上下文同为系统注入，标记 source: "system"
    expect(recovery!.source).toBe("system");
    expect(recovery!.content).toContain("src/b.ts、src/a.ts");
    expect(recovery!.content).toContain("继续重构");
    expect(recovery!.content).toContain("会话开始：重构项目");
  });

  it("权限拒绝时不执行工具并回灌错误消息", async () => {
    let executed = false;
    const bashTool: Tool = {
      name: "bash",
      description: "执行命令",
      inputSchema: z.object({ command: z.string() }),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: () => {
        executed = true;
        return "命令输出";
      },
    };
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "bash" };
            yield { type: "toolcall_delta", index: 0, partialJson: '{"command":"rm x"}' };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "完成" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [bashTool],
      permission: new PermissionPipeline({ rules: [parseRuleString("bash", "deny")] }),
    });
    agent.start("执行命令");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    expect(executed).toBe(false); // 被拒未执行
    const result = agent.getMessages().find((m) => m.role === "tool_result");
    expect(result).toMatchObject({
      role: "tool_result",
      toolCallId: "c1",
      isError: true,
      content: "权限拒绝：规则拒绝",
    });
  });

  it("权限允许时正常执行工具", async () => {
    const bashTool: Tool = {
      name: "bash",
      description: "执行命令",
      inputSchema: z.object({ command: z.string() }),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: () => "命令输出",
    };
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "bash" };
            yield { type: "toolcall_delta", index: 0, partialJson: '{"command":"ls"}' };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "完成" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [bashTool],
      permission: new PermissionPipeline({ rules: [parseRuleString("bash", "allow")] }),
    });
    agent.start("执行命令");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const result = agent.getMessages().find((m) => m.role === "tool_result");
    expect(result).toMatchObject({
      role: "tool_result",
      toolCallId: "c1",
      isError: false,
      content: "命令输出",
    });
  });
});
