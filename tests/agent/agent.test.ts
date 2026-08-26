import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import { PRUNED_MARKER } from "../../src/context/index.js";
import { assistantMessage, toolResultMessage, userMessage, type Message, type UserMessage, type Context, type ThinkingLevel } from "../../src/core/index.js";
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
    expect(messages[0]).toEqual({ role: "user", id: expect.any(String), content: "你好", timestamp: expect.any(String) });
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
    expect(messages[0]).toEqual({ role: "user", id: expect.any(String), content: "第一个问题", timestamp: expect.any(String) });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "第一轮回复" }],
    });
    expect(messages[2]).toEqual({ role: "user", id: expect.any(String), content: "第二个问题", timestamp: expect.any(String) });
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

  it("resetHistory 清空消息历史：清空后再 start 只带新输入（/clear 回会话新建态用）", async () => {
    const agent = new Agent({
      modelClient: mockTextClient("旧回复"),
      modelId: "mock",
      systemPrompt: "助手",
    });
    agent.start("旧问题");
    for await (const _ of agent.run()) {
      // 消费事件流
    }
    expect(agent.getMessages().length).toBeGreaterThan(0);

    // /clear 链路：清空 agent 历史
    agent.resetHistory();
    expect(agent.getMessages()).toEqual([]);

    // 清空后再 start：新输入成为唯一消息（旧历史不回灌模型）
    agent.start("新问题");
    expect(agent.getMessages()).toHaveLength(1);
    expect(agent.getMessages()[0]).toMatchObject({ role: "user", content: "新问题" });
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

  it("续跑修复：末尾孤立的工具调用补「执行中断」失败结果（checkpoint 崩溃恢复）", async () => {
    // 模拟崩溃后的盘上状态：user + assistant(工具调用)，无 tool_result
    const orphanHistory: Message[] = [
      userMessage("读文件"),
      assistantMessage([{ type: "tool_call", id: "c1", name: "read", input: { path: "a.ts" } }]),
    ];
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const lastToolResult = [...context.messages].reverse().find((m) => m.role === "tool_result");
          if (!lastToolResult) {
            yield { type: "text_delta", text: "开始" };
            yield { type: "done", stopReason: "end_turn" };
            return;
          }
          // 模型看到「执行中断」失败结果后总结
          yield { type: "text_delta", text: `已看到中断：${String(lastToolResult.content)}` };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      initialMessages: orphanHistory,
    });
    // 构造时已修复配对：孤儿调用补了失败结果
    const repaired = agent.getMessages();
    expect(repaired).toHaveLength(3);
    expect(repaired[2]).toMatchObject({
      role: "tool_result",
      toolCallId: "c1",
      isError: true,
      content: expect.stringContaining("工具执行中断"),
    });
    // 续跑正常：模型看到失败结果，不会 400
    agent.start("继续");
    const events: StreamEvent[] = [];
    for await (const e of agent.run()) events.push(e);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
  });

  it("正常历史末尾配对完整时不做修复", async () => {
    const complete: Message[] = [
      userMessage("读文件"),
      assistantMessage([{ type: "tool_call", id: "c1", name: "read", input: {} }]),
      toolResultMessage("c1", "read", "内容", false),
      assistantMessage([{ type: "text", text: "总结" }]),
    ];
    const agent = new Agent({
      modelClient: mockTextClient("继续"),
      modelId: "mock",
      systemPrompt: "助手",
      initialMessages: complete,
    });
    expect(agent.getMessages()).toHaveLength(4);
  });

  it("checkpoint：工具执行前回调已产生的消息（用户输入 + 含调用的回复）", async () => {
    let checkpointSeen: Message[] = [];
    let toolRan = false;
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "read" };
            yield { type: "toolcall_delta", index: 0, partialJson: '{"path":"a.ts"}' };
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
      tools: [{
        name: "read",
        description: "读取文件",
        inputSchema: z.object({ path: z.string() }),
        isReadOnly: true,
        requiresUserInteraction: false,
        maxResultSizeChars: 100,
        execute: () => {
          toolRan = true;
          return "内容";
        },
      }],
      checkpoint: (messages) => {
        checkpointSeen = [...messages];
      },
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费
    }
    // checkpoint 在工具执行前拿到 user + assistant（含工具调用），不含 tool_result
    expect(toolRan).toBe(true);
    expect(checkpointSeen.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(checkpointSeen[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool_call", id: "c1", name: "read" }],
    });
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

  it("工具输出超过上限时落盘完整内容并回灌路径提示", async () => {
    const bigTool: Tool = {
      name: "big",
      description: "返回超长输出",
      inputSchema: z.object({}),
      isReadOnly: true,
      requiresUserInteraction: false,
      maxResultSizeChars: 10,
      execute: () => "一二三四五六七八九十十一十二十三十四十五",
    };
    const outDir = mkdtempSync(path.join(tmpdir(), "minicode-out-"));
    try {
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
        outputDir: outDir,
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
        content: expect.stringContaining("[输出已截断：共 20 字符，完整内容已保存到"),
      });
      const outputFile = result && typeof result.content === "string"
        ? result.content.match(/已保存到 (\S+)，可用 Read/)?.[1]
        : undefined;
      expect(outputFile).toBeDefined();
      // 落盘文件内容与原始输出完全一致（无损读回）
      const saved = await import("node:fs/promises").then((fs) => fs.readFile(outputFile!, "utf8"));
      expect(saved).toBe("一二三四五六七八九十十一十二十三十四十五");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
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

  it("compactNow：用户主动压缩，无视撞线判断强制走分层压缩", async () => {
    // 摘要调用（tools 为空）返回摘要文本；正常调用返回普通文本
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        if (context.tools.length === 0) {
          yield { type: "text_delta", text: "主动压缩摘要" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "text_delta", text: "正常回复" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const agent = new Agent({
      modelClient,
      modelId: "mock",
      systemPrompt: "助手",
      initialMessages: [userMessage("第一问"), assistantMessage([{ type: "text", text: "回答一" }])],
      tools: [{
        name: "echo",
        description: "回显",
        inputSchema: z.object({}),
        isReadOnly: false,
        requiresUserInteraction: false,
        maxResultSizeChars: 1000,
        execute: () => "回显",
      }],
      // 窗口很大：未撞线，普通 run 不会压缩
      compactConfig: { contextWindow: 100000, maxOutputTokens: 1000, safetyMargin: 500, keepRecentToolResults: 1 },
    });
    agent.start("继续");
    for await (const _ of agent.run()) {
      // 消费
    }
    expect(agent.getMessages().some((m) => typeof m.content === "string" && m.content.includes("【会话摘要】"))).toBe(false);

    // 主动压缩：强制摘要替换
    expect(await agent.compactNow()).toBe(true);
    const messages = agent.getMessages();
    expect(messages[0]).toMatchObject({
      role: "user",
      source: "system",
      content: expect.stringContaining("【会话摘要】"),
    });
    // 压缩后仍可继续对话
    agent.start("压缩后继续");
    for await (const _ of agent.run()) {
      // 消费
    }
    expect(agent.getMessages().at(-1)).toMatchObject({ role: "assistant" });
  });

  it("compactNow：未配置压缩时返回 false，不动消息", async () => {
    const agent = new Agent({
      modelClient: {
        async *stream() {
          yield { type: "text_delta", text: "hi" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      initialMessages: [userMessage("第一问")],
    });
    expect(await agent.compactNow()).toBe(false);
    expect(agent.getMessages()).toHaveLength(1);
  });

  it("compactNow：摘要一次失败后显式请求仍可重试（绕过失败保护，撞线仍受保护）", async () => {
    // 摘要调用（消息含摘要请求）第一次抛错，之后成功；撞线自动压缩在此场景不触发
    let summaryCalls = 0;
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        const isSummaryRequest = context.messages.some(
          (m) => typeof m.content === "string" && m.content.includes("结构化摘要"),
        );
        if (isSummaryRequest) {
          summaryCalls++;
          if (summaryCalls === 1) throw new Error("摘要模型瞬断");
          yield { type: "text_delta", text: "终于成功" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "text_delta", text: "正常回复" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const agent = new Agent({
      modelClient,
      modelId: "mock",
      systemPrompt: "助手",
      initialMessages: [userMessage("第一问"), assistantMessage([{ type: "text", text: "回答一" }])],
      tools: [{
        name: "echo",
        description: "回显",
        inputSchema: z.object({}),
        isReadOnly: false,
        requiresUserInteraction: false,
        maxResultSizeChars: 1000,
        execute: () => "回显",
      }],
      compactConfig: { contextWindow: 100000, maxOutputTokens: 1000, safetyMargin: 500, keepRecentToolResults: 1 },
    });

    // 第一次主动压缩失败（摘要抛错，置位 compactDisabled）
    expect(await agent.compactNow()).toBe(false);
    // 第二次主动压缩绕过保护重试成功
    expect(await agent.compactNow()).toBe(true);
    expect(agent.getMessages()[0]).toMatchObject({
      role: "user",
      source: "system",
      content: expect.stringContaining("【会话摘要】"),
    });
  });

  it("增量合并（DESIGN 9.7）：第二次压缩只读旧摘要后的增量，附旧摘要合并，不重读全量历史", async () => {
    // 记录每次摘要调用收到的消息数与请求内容
    const summaryRequests: { messages: number; hasPrevious: boolean; deltaFirstStartsRecovery: boolean }[] = [];
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        const isSummaryRequest = context.messages.some(
          (m) => typeof m.content === "string" && m.content.includes("结构化摘要"),
        );
        if (isSummaryRequest) {
          const prev = context.messages.some((m) => typeof m.content === "string" && m.content.includes("旧摘要"));
          // 增量不应包含恢复上下文（内容已被旧摘要覆盖，不算增量）
          const hasRecoveryInDelta = context.messages.some(
            (m) =>
              m.role === "user" &&
              (m as { source?: string }).source === "system" &&
              typeof m.content === "string" &&
              m.content.startsWith("【恢复上下文】"),
          );
          summaryRequests.push({
            messages: context.messages.length,
            hasPrevious: prev,
            deltaFirstStartsRecovery: hasRecoveryInDelta,
          });
          yield { type: "text_delta", text: prev ? "合并后的摘要" : "首次摘要" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "text_delta", text: "正常回复" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const agent = new Agent({
      modelClient,
      modelId: "mock",
      systemPrompt: "助手",
      // 历史足够大：第一次压缩会撞线
      initialMessages: Array.from({ length: 10 }, (_, i) => userMessage(`历史消息${i} `.repeat(50))),
      tools: [{
        name: "echo",
        description: "回显",
        inputSchema: z.object({}),
        isReadOnly: false,
        requiresUserInteraction: false,
        maxResultSizeChars: 1000,
        execute: () => "回显",
      }],
      // 窗口：首次撞线（10 条历史约 900 token）；摘要后增量（恢复上下文+大输入约 364 token）不撞线，
      // 第二次压缩由 compactNow 显式触发
      compactConfig: { contextWindow: 500, maxOutputTokens: 30, safetyMargin: 20, keepRecentToolResults: 1 },
    });
    agent.start("第一轮");
    for await (const _ of agent.run()) {
      // 消费
    }
    // 第一次压缩：全量总结，无旧摘要
    expect(summaryRequests).toHaveLength(1);
    expect(summaryRequests[0]).toMatchObject({ hasPrevious: false });
    // 摘要消息已就位
    expect(agent.getMessages()[0]).toMatchObject({
      role: "user",
      source: "system",
      content: expect.stringContaining("【会话摘要】"),
    });

    // 继续对话制造增量后再次压缩：只读增量 + 旧摘要合并（消息数远小于全量历史）
    agent.start("增量问题".repeat(80));
    for await (const _ of agent.run()) {
      // 消费
    }
    expect(await agent.compactNow()).toBe(true);
    expect(summaryRequests).toHaveLength(2);
    expect(summaryRequests[1]).toMatchObject({ hasPrevious: true });
    // 增量请求消息数（增量 + 摘要请求）远小于首次（10 条历史 + 请求）
    expect(summaryRequests[1]!.messages).toBeLessThan(summaryRequests[0]!.messages);
    // 增量不含恢复上下文（内容已被旧摘要覆盖）：增量首条是真实对话消息
    expect(summaryRequests[1]!.deltaFirstStartsRecovery).toBe(false);
    expect(agent.getMessages()[0]).toMatchObject({
      role: "user",
      source: "system",
      content: expect.stringContaining("【会话摘要】"),
    });
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
    expect(messages[0]).toEqual({ role: "user", id: expect.any(String), content: "短消息", timestamp: expect.any(String) });
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

  it("thinkingLevelRef → stream 的 context.thinkingLevel（思考等级透传；无 ref 时缺省）", async () => {
    let captured: ThinkingLevel | undefined = undefined;
    const client: ModelClient = {
      async *stream(_modelId, context) {
        captured = (context as Context).thinkingLevel;
        yield { type: "text_delta", text: "ok" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const agent = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "s",
      thinkingLevelRef: () => "medium" as ThinkingLevel,
    });
    agent.start("hi");
    for await (const _e of agent.run()) {
      /* 消费事件 */
    }
    expect(captured).toBe("medium");

    // 未传 ref：context.thinkingLevel 为 undefined（厂商默认）
    let captured2: ThinkingLevel | undefined = undefined;
    const client2: ModelClient = {
      async *stream(_m, c) {
        captured2 = (c as Context).thinkingLevel;
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const a2 = new Agent({ modelClient: client2, modelId: "mock", systemPrompt: "s" });
    a2.start("hi");
    for await (const _e of a2.run()) {
      /* 消费事件 */
    }
    expect(captured2).toBeUndefined();
  });
});
