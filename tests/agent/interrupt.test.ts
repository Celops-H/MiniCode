import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import type { StreamEvent } from "../../src/core/index.js";
import type { Tool } from "../../src/tools/index.js";

/**
 * 等待 signal 中止，中止时抛 AbortError（模拟底层流在 abort 时中断）。
 * 中断在 await 处触发时 reject，流随之抛错——与真实 parseStream 的中断路径一致。
 */
function abortWait(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(abortError());
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

/** 首段文本后挂起等 abort 的 mock 流：中断页抛错，模拟 openai 兼容流被 abort 的形态 */
function abortableTextClient(first: string, rest?: string[]): ModelClient {
  return {
    async *stream(_modelId, _context, options) {
      yield { type: "text_delta", text: first };
      try {
        await abortWait(options?.signal!);
      } catch (err) {
        // 先发 error（观测通道，与 parseStream 一致），再抛——runTurn 应抑制这个伪 error
        yield { type: "error", message: "The operation was aborted" };
        throw err;
      }
      for (const t of rest ?? []) yield { type: "text_delta", text: t };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

function run(agent: Agent, onEvent?: (e: StreamEvent) => void): Promise<StreamEvent[]> {
  return (async () => {
    const events: StreamEvent[] = [];
    for await (const e of agent.run()) {
      events.push(e);
      onEvent?.(e);
    }
    return events;
  })();
}

describe("Agent 主循环：turn 内真打断", () => {
  it("模型流中中断：pending 立即停、已收文本保留、伪 error 不转发", async () => {
    const agent = new Agent({
      modelClient: abortableTextClient("你好，我正在思考"),
      modelId: "mock",
      systemPrompt: "助手",
    });
    agent.start("打断测试");
    const events = await run(agent, (e) => {
      if (e.type === "text_delta") agent.interrupt();
    });

    // 收到首段文本即打断：宿主只见 text_delta，不见「中断=错误」的伪 error 与未完成的 done
    expect(events).toEqual([{ type: "text_delta", text: "你好，我正在思考" }]);
    expect(events.some((e) => e.type === "error")).toBe(false);
    // 已产出保留：半截文本落成 assistant；中断状态置位
    const messages = agent.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "你好，我正在思考" }],
    });
    expect(agent.isInterrupted()).toBe(true);
  });

  it("含未执行工具调用时中断：调用保留 + 补失败结果配对闭合", async () => {
    const client: ModelClient = {
      async *stream(_modelId, _context, options) {
        yield { type: "text_delta", text: "我先看一下代码" };
        yield { type: "toolcall_start", index: 0, id: "call_1", name: "bash" };
        yield { type: "toolcall_delta", index: 0, partialJson: `{"command":"sleep 5"}` };
        yield { type: "toolcall_end", index: 0 };
        try {
          await abortWait(options?.signal!);
        } catch (err) {
          throw err;
        }
      },
    };
    const agent = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      tools: [
        {
          name: "bash",
          description: "执行命令",
          inputSchema: z.object({ command: z.string() }),
          isReadOnly: false,
          requiresUserInteraction: false,
          maxResultSizeChars: 1000,
          execute: (input) => String((input as { command: string }).command),
        },
      ],
    });
    agent.start("工具打断");
    const events = await run(agent, (e) => {
      if (e.type === "toolcall_end") agent.interrupt();
    });

    // 模型含工具调用即被打断：不执行工具，调用保留 + 补「执行中断」失败结果（续跑不 400）
    const messages = agent.getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "我先看一下代码" },
        { type: "tool_call", id: "call_1", name: "bash" },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: "tool_result",
      toolCallId: "call_1",
      toolName: "bash",
      isError: true,
      content: expect.stringContaining("执行中断"),
    });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("工具执行中中断：执行中的工具收到 abort 返回失败结果回灌", async () => {
    let markStarted: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    // 模拟 bash 类长工具：execute 挂起，收到 signal.abort 时返回失败结果（true 形态与 killProcessTree 杀树一致）
    const hungTool: Tool = {
      name: "bash",
      description: "模拟长命令",
      inputSchema: z.object({ command: z.string() }),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 5000,
      execute(_input, options) {
        markStarted!();
        return new Promise((resolve) => {
          options?.signal?.addEventListener(
            "abort",
            () => resolve({ output: "(命令已被用户打断)", isError: true }),
            { once: true },
          );
        });
      },
    };
    const client: ModelClient = {
      async *stream(_modelId, _context) {
        yield { type: "toolcall_start", index: 0, id: "call_1", name: "bash" };
        yield { type: "toolcall_delta", index: 0, partialJson: `{"command":"sleep 100"}` };
        yield { type: "toolcall_end", index: 0 };
        yield { type: "done", stopReason: "tool_use" };
      },
    };
    const agent = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      tools: [hungTool],
    });
    agent.start("工具中段中断");
    const runPromise = run(agent);
    await started; // 工具已开始执行（execute 挂起）
    agent.interrupt();
    const events = await runPromise;

    // 中断结果经 PostToolUse 正常回灌，观测闭合
    const messages = agent.getMessages();
    expect(messages[2]).toMatchObject({
      role: "tool_result",
      toolCallId: "call_1",
      isError: true,
      content: expect.stringContaining("已被用户打断"),
    });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("中断后 start 复活：新对话可正常完成", async () => {
    let calls = 0;
    const client: ModelClient = {
      async *stream(_modelId, _context, options) {
        calls++;
        if (calls === 1) {
          yield { type: "text_delta", text: "第一段" };
          try {
            await abortWait(options?.signal!);
          } catch (err) {
            throw err;
          }
        }
        yield { type: "text_delta", text: "完成回复" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const agent = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
    });
    agent.start("第一次");
    const first = await run(agent, (e) => {
      if (e.type === "text_delta") agent.interrupt();
    });
    expect(first).toHaveLength(1); // 只收到半截

    // start 复位中断信号与状态：新对话走完整轮
    agent.start("继续");
    const second = await run(agent);
    expect(second.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    const messages = agent.getMessages();
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "完成回复" }],
    });
    expect(agent.isInterrupted()).toBe(false);
  });

  it("并发批工具中断：批内全部调用收敛为失败结果、配对闭合", async () => {
    let markStarted: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let startedCount = 0;
    const hungTool: Tool = {
      name: "bash",
      description: "模拟长命令",
      inputSchema: z.object({ command: z.string() }),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 5000,
      // 两个调用判定并发安全，进同一并发批（批内并行执行）
      isConcurrencySafe: () => true,
      execute(_input, options) {
        startedCount++;
        if (startedCount === 2) markStarted!();
        return new Promise((resolve) => {
          options?.signal?.addEventListener(
            "abort",
            () => resolve({ output: "(命令已被用户打断)", isError: true }),
            { once: true },
          );
        });
      },
    };
    const client: ModelClient = {
      async *stream() {
        for (const [index, id, command] of [
          [0, "call_1", "a"],
          [1, "call_2", "b"],
        ] as const) {
          yield { type: "toolcall_start", index, id, name: "bash" };
          yield { type: "toolcall_delta", index, partialJson: `{"command":"${command}"}` };
          yield { type: "toolcall_end", index };
        }
        yield { type: "done", stopReason: "tool_use" };
      },
    };
    const agent = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      tools: [hungTool],
    });
    agent.start("并发批中断");
    const runPromise = run(agent);
    await started; // 批内两个调用都已开始执行
    agent.interrupt();
    await runPromise;

    const messages = agent.getMessages();
    const results = messages.filter((m) => m.role === "tool_result");
    // 两个调用都有结果回灌（配对闭合）：执行中被 abort 的结果 + 未及启动的前置检查拦下
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ toolCallId: "call_1", isError: true });
    expect(results[1]).toMatchObject({ toolCallId: "call_2", isError: true });
  });
});