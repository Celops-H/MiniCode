import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import type { StreamEvent } from "../../src/core/index.js";
import type { Tool } from "../../src/tools/index.js";
import { OpenAICompletionsProtocol } from "../../src/llm/index.js";

afterEach(() => {
  vi.useRealTimers();
});

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

  it("思考中打断（只产 thinking）：续跑请求体不产生空 content assistant（A400 回归）", async () => {
    const protocol = new OpenAICompletionsProtocol({ reasoningContent: true });
    let calls = 0;
    let secondBody: unknown;
    const client: ModelClient = {
      async *stream(_modelId, ctx, options) {
        calls++;
        if (calls === 1) {
          // 第一轮：只产思考增量后挂起等 abort（思考中打断，无文本产出）
          yield { type: "thinking_delta", thinking: "正在分析问题" };
          try {
            await abortWait(options?.signal!);
          } catch (err) {
            throw err;
          }
        }
        // 第二轮（续跑）：用真实协议把当前上下文转成请求体，供断言合法性
        secondBody = protocol.buildRequest(ctx);
        yield { type: "text_delta", text: "续跑回复完成" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const agent = new Agent({ modelClient: client, modelId: "mock", systemPrompt: "助手" });
    agent.start("首次思考");
    await run(agent, (e) => {
      if (e.type === "thinking_delta") agent.interrupt();
    });
    // 打断收尾保留 thinking-only assistant（已产出思考留在历史）
    const interrupted = agent.getMessages();
    expect(interrupted).toHaveLength(2);
    expect(interrupted[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "thinking", thinking: "正在分析问题" }],
    });

    // 续跑：请求体里每条 assistant 都有 content 或 tool_calls（复现「content or tool_calls must be set」的场景不再出现）
    agent.start("继续");
    await run(agent);
    const body = secondBody as { messages: Array<Record<string, unknown>> };
    for (const msg of body.messages) {
      if (msg.role === "assistant") {
        // 语义明确：content 或 tool_calls 至少一个非空（空数组也是 falsy 误判，用 length 判定）
        expect(
          (Array.isArray(msg.content) ? (msg.content as unknown[]).length : 0) > 0 ||
            (Array.isArray(msg.tool_calls) ? (msg.tool_calls as unknown[]).length : 0) > 0,
        ).toBe(true);
      }
    }
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

  it("流忽略 abort 永不结束：中断看门狗 3s 强制收尾，run 不被永久卡住", async () => {
    vi.useFakeTimers();
    // 忽略 signal 的永挂流（模拟 SDK/厂商不响应 abort，真机「打断后一切无响应」场景）
    const client: ModelClient = {
      async *stream() {
        yield { type: "text_delta", text: "开头段" };
        await new Promise<void>(() => {}); // 永不 resolve
      },
    };
    const agent = new Agent({ modelClient: client, modelId: "mock", systemPrompt: "助手" });
    agent.start("看门狗");
    const eventsPromise = run(agent);
    await Promise.resolve(); // 让流推进到挂起点
    agent.interrupt();
    await vi.advanceTimersByTimeAsync(3_001); // 看门狗超时触发
    const events = await eventsPromise;
    // 已产出保留、回合收尾（不再永久挂起，宿主输入循环可恢复）
    expect(events).toEqual([{ type: "text_delta", text: "开头段" }]);
    expect(agent.getMessages()).toHaveLength(2); // user + 半截 assistant
  });

  it("工具忽略 signal 挂起：中断看门狗 3s 强制失败结果，回合不被卡死", async () => {
    vi.useFakeTimers();
    let markStarted: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    // 忽略 signal 的挂起工具（模拟非 bash 类工具不响应 abort）
    const hungTool: Tool = {
      name: "bash",
      description: "挂起工具",
      inputSchema: z.object({}),
      isReadOnly: false,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute() {
        markStarted!();
        return new Promise<string>(() => {}); // 永不 resolve
      },
    };
    const client: ModelClient = {
      async *stream() {
        yield { type: "toolcall_start", index: 0, id: "call_1", name: "bash" };
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
    agent.start("工具看门狗");
    const runPromise = run(agent);
    await started; // 工具已开始执行（挂起）
    agent.interrupt();
    await vi.advanceTimersByTimeAsync(3_001); // 工具看门狗超时
    await runPromise;
    // 挂起工具被强制转失败结果（配对闭合），回合收尾
    const messages = agent.getMessages();
    const result = messages.find((m) => m.role === "tool_result");
    expect(result).toMatchObject({ toolCallId: "call_1", isError: true });
    expect(result?.content).toContain("工具 bash 执行失败");
  });

  it("只读快工具正常执行挂起：正常执行超时兜底，回合不被无打断卡死", async () => {
    // 只读快工具（模拟 glob/read 异常挂起）：不响应中断、也用不到打断；
    // 用注入的短超时（100ms），真实计时器驱动，不依赖 fake timers
    let markStarted: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const hungReadonly: Tool = {
      name: "glob",
      description: "只读快工具",
      inputSchema: z.object({}),
      isReadOnly: true,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute() {
        markStarted!();
        return new Promise<string>(() => {}); // 永不 resolve（模拟异常挂起）
      },
    };
    const client: ModelClient = {
      async *stream(_modelId, ctx) {
        // 第一轮发工具调用；回灌失败结果后模型改发总结，回合结束（避免 mock 无限重试）
        if (ctx.messages.some((m) => m.role === "tool_result")) {
          yield { type: "text_delta", text: "工具超时，我换个思路" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "toolcall_start", index: 0, id: "call_1", name: "glob" };
        yield { type: "toolcall_end", index: 0 };
        yield { type: "done", stopReason: "tool_use" };
      },
    };
    const agent = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      tools: [hungReadonly],
      toolTimeoutMs: 100, // 短超时，真实计时器驱动
    });
    agent.start("只读超时");
    const runPromise = run(agent);
    await started; // 工具已开始执行（挂起），未打断
    await runPromise;
    // 挂起的只读工具被强制转失败结果（配对闭合），回合收尾不卡死
    const messages = agent.getMessages();
    const result = messages.find((m) => m.role === "tool_result");
    expect(result).toMatchObject({ toolCallId: "call_1", isError: true });
    expect(result?.content).toContain("工具执行超时");
    expect(agent.isInterrupted()).toBe(false);
  });

  it("只读快工具正常完成：超时兜底不误伤，正常结果回灌", async () => {
    vi.useFakeTimers();
    const client: ModelClient = {
      async *stream() {
        yield { type: "toolcall_start", index: 0, id: "call_1", name: "glob" };
        yield { type: "toolcall_end", index: 0 };
        yield { type: "done", stopReason: "tool_use" };
      },
    };
    const okReadonly: Tool = {
      name: "glob",
      description: "只读快工具",
      inputSchema: z.object({}),
      isReadOnly: true,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: () => "找到文件 A",
    };
    const agent = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      tools: [okReadonly],
    });
    agent.start("只读正常");
    const runPromise = run(agent);
    // 工具同步返回，无需推进假时钟（正常路径不受超时兜底影响）
    await runPromise;
    const messages = agent.getMessages();
    const result = messages.find((m) => m.role === "tool_result");
    expect(result).toMatchObject({ toolCallId: "call_1", isError: false });
    expect(result?.content).toContain("找到文件 A");
    expect(result?.content).not.toContain("执行超时");
  });

  it("只读工具接近超时边界正常完成：不被超时兜底误杀（真实计时器）", async () => {
    // 注入 100ms 短超时 + 真实计时器，工具在超时前（50ms）完成——覆盖"合法耗时但未到超时"的边界
    const client: ModelClient = {
      async *stream(_modelId, ctx) {
        if (ctx.messages.some((m) => m.role === "tool_result")) {
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        yield { type: "toolcall_start", index: 0, id: "call_1", name: "glob" };
        yield { type: "toolcall_end", index: 0 };
        yield { type: "done", stopReason: "tool_use" };
      },
    };
    const slowReadonly: Tool = {
      name: "glob",
      description: "只读但需要点时间",
      inputSchema: z.object({}),
      isReadOnly: true,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: () => new Promise((resolve) => setTimeout(() => resolve("慢但完成"), 50)),
    };
    const agent = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      tools: [slowReadonly],
      toolTimeoutMs: 100, // 短超时，真实计时器驱动；工具 50ms 完成 < 100ms
    });
    agent.start("只读边界");
    await run(agent);
    const messages = agent.getMessages();
    const result = messages.find((m) => m.role === "tool_result");
    expect(result).toMatchObject({ toolCallId: "call_1", isError: false });
    expect(result?.content).toContain("慢但完成");
    expect(result?.content).not.toContain("执行超时");
  });
});