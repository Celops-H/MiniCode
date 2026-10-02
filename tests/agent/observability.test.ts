import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import type { HookEvent } from "../../src/hooks/index.js";
import { HookBus } from "../../src/hooks/index.js";
import { PermissionPipeline, parseRuleString } from "../../src/permission/index.js";
import { assistantMessage, userMessage, type Message } from "../../src/core/index.js";
import type { Tool } from "../../src/tools/index.js";

/** 收集某类事件的处理器：记录全部负载供断言 */
function collector<T extends HookEvent["type"]>(hooks: HookBus, type: T): { events: Extract<HookEvent, { type: T }>[] } {
  const events: Extract<HookEvent, { type: T }>[] = [];
  hooks.on(type, (e) => {
    events.push(e as Extract<HookEvent, { type: T }>);
  });
  return { events };
}

function textClient(text: string): ModelClient {
  return {
    async *stream() {
      yield { type: "text_delta", text };
      yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
}

/** 模型先请求一次 read 工具，看到结果后总结 */
function readToolClient(): ModelClient {
  return {
    async *stream(_modelId, context) {
      const hasResult = context.messages.some((m) => m.role === "tool_result");
      if (!hasResult) {
        yield { type: "toolcall_start", index: 0, id: "c1", name: "read" };
        yield { type: "toolcall_end", index: 0 };
        yield { type: "done", stopReason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: "已读" };
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
}

function makeReadTool(execute: Tool["execute"]): Tool {
  return {
    name: "read",
    description: "读取文件",
    inputSchema: z.object({}),
    isReadOnly: true,
    maxResultSizeChars: 1000,
    execute,
  };
}

async function drain(agent: Agent): Promise<void> {
  for await (const _ of agent.run()) {
    // 消费事件流
  }
}

describe("MessageAppended 事件：消息追加路径全覆盖", () => {
  it("常规轮次：用户输入、assistant 回复、工具结果各发一条（含完整消息对象）", async () => {
    const hooks = new HookBus();
    const appended = collector(hooks, "MessageAppended");
    const agent = new Agent({
      modelClient: readToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      tools: [makeReadTool(() => "文件内容")],
    });
    agent.start("读文件");
    await drain(agent);

    const messages = appended.events.map((e) => e.message);
    expect(messages).toHaveLength(4); // 用户输入 + assistant(工具调用) + 工具结果 + assistant(总结)
    expect(messages[0]).toMatchObject({ role: "user", content: "读文件" });
    expect(messages[1]).toMatchObject({ role: "assistant" });
    expect(messages[2]).toMatchObject({ role: "tool_result", toolCallId: "c1", content: "文件内容" });
    expect(messages[3]).toMatchObject({ role: "assistant" });
    // 全部归属 /root（独立 agent 无团队）
    expect(appended.events.every((e) => e.agentPath === "/root")).toBe(true);
  });

  it("命令消息（appendCommand）发一条，带 COMMAND_MARKER 前缀原文", async () => {
    const hooks = new HookBus();
    const appended = collector(hooks, "MessageAppended");
    const agent = new Agent({
      modelClient: textClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
    });
    agent.start("问题");
    agent.appendCommand("/compact 侧重保留命令输出");
    await drain(agent);

    const command = appended.events.map((e) => e.message).find((m) => m.role === "user" && m.source === "command");
    expect(command).toMatchObject({ content: "【命令】/compact 侧重保留命令输出" });
  });

  it("收件箱注入（source: system）发一条", async () => {
    const hooks = new HookBus();
    const appended = collector(hooks, "MessageAppended");
    const agent = new Agent({
      modelClient: textClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
    });
    agent.start("问题");
    agent.deliver({ type: "MESSAGE", from: "/root/peer" as never, content: "同事留言", triggerTurn: false });
    await drain(agent);

    const injected = appended.events.map((e) => e.message).find((m) => m.role === "user" && m.source === "system");
    expect(injected?.content).toContain("同事留言");
  });

  it("中断收尾：半截 assistant 与合成的「执行中断」工具结果各发一条（不走 executeTool 的 push 路径也覆盖）", async () => {
    const hooks = new HookBus();
    const appended = collector(hooks, "MessageAppended");
    // 流产出工具调用后挂起等中断信号
    const agent = new Agent({
      modelClient: {
        async *stream(_id, _ctx, options) {
          yield { type: "toolcall_start", index: 0, id: "c1", name: "read" };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve();
            else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new DOMException("Aborted", "AbortError");
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      tools: [makeReadTool(() => "不应执行")],
    });
    agent.start("读文件");
    const consuming = drain(agent);
    agent.interrupt();
    await consuming;

    const messages = appended.events.map((e) => e.message);
    // 用户输入 + assistant(工具调用) + 合成的中断失败结果
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({ role: "assistant" });
    expect(messages[2]).toMatchObject({ role: "tool_result", content: "执行中断：用户打断，工具未执行" });
  });

  it("崩溃恢复补孤儿的合成结果：延迟补发且先于本轮用户输入（轨迹补齐、顺序与上下文一致）", async () => {
    const hooks = new HookBus();
    const appended = collector(hooks, "MessageAppended");
    // 模拟崩溃后的盘上状态：user + assistant(工具调用)，无 tool_result
    const orphanHistory: Message[] = [
      userMessage("读文件"),
      assistantMessage([{ type: "tool_call", id: "c1", name: "read", input: {} }]),
    ];
    const agent = new Agent({
      modelClient: textClient("继续"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      initialMessages: orphanHistory,
    });
    // 构造函数不能发射事件：此刻没有任何镜像，待首次驱动补发
    expect(appended.events).toHaveLength(0);
    agent.start("继续");
    await drain(agent);

    const messages = appended.events.map((e) => e.message);
    // 合成结果先于本轮用户输入（它在历史末尾、输入之前），内容为「执行中断」失败结果
    expect(messages).toHaveLength(3); // 合成结果 + 用户输入 + assistant 回复
    expect(messages[0]).toMatchObject({
      role: "tool_result",
      toolCallId: "c1",
      isError: true,
      content: expect.stringContaining("工具执行中断"),
    });
    expect(messages[1]).toMatchObject({ role: "user", content: "继续" });
  });

  it("崩溃恢复孤儿含多个工具调用：逐条按序补发，先于本轮用户输入", async () => {
    const hooks = new HookBus();
    const appended = collector(hooks, "MessageAppended");
    const orphanHistory: Message[] = [
      userMessage("并行查"),
      assistantMessage([
        { type: "tool_call", id: "c1", name: "read", input: {} },
        { type: "tool_call", id: "c2", name: "glob", input: {} },
      ]),
    ];
    const agent = new Agent({
      modelClient: textClient("继续"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      initialMessages: orphanHistory,
    });
    agent.start("继续");
    await drain(agent);

    const messages = appended.events.map((e) => e.message);
    expect(messages).toHaveLength(4); // 两条合成结果 + 用户输入 + assistant 回复
    expect(messages[0]).toMatchObject({ role: "tool_result", toolCallId: "c1", isError: true });
    expect(messages[1]).toMatchObject({ role: "tool_result", toolCallId: "c2", isError: true });
    expect(messages[2]).toMatchObject({ role: "user", content: "继续" });
  });

  it("清盘（resetHistory）丢弃未发射的待镜像消息：消息已不在上下文，不补发", async () => {
    const hooks = new HookBus();
    const appended = collector(hooks, "MessageAppended");
    const orphanHistory: Message[] = [
      userMessage("读文件"),
      assistantMessage([{ type: "tool_call", id: "c1", name: "read", input: {} }]),
    ];
    const agent = new Agent({
      modelClient: textClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      initialMessages: orphanHistory,
    });
    agent.resetHistory();
    agent.start("新话题");
    await drain(agent);

    const messages = appended.events.map((e) => e.message);
    expect(messages).toHaveLength(2); // 用户输入 + assistant 回复，无补发
    expect(messages[0]).toMatchObject({ role: "user", content: "新话题" });
  });

  it("不经 start 直接驱动（runTurn 入口补发）：收件箱唤醒续跑等路径同样补齐轨迹", async () => {
    const hooks = new HookBus();
    const appended = collector(hooks, "MessageAppended");
    const orphanHistory: Message[] = [
      userMessage("读文件"),
      assistantMessage([{ type: "tool_call", id: "c1", name: "read", input: {} }]),
    ];
    const agent = new Agent({
      modelClient: textClient("继续"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      initialMessages: orphanHistory,
    });
    await drain(agent);

    const messages = appended.events.map((e) => e.message);
    // 合成结果先补发，其后才是本轮 assistant 回复
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "tool_result", toolCallId: "c1", isError: true });
    expect(messages[1]).toMatchObject({ role: "assistant" });
  });

  it("恢复会话未经回合直接压缩（doCompact 入口补发）：合成结果先于摘要消息发射，不随摘要替换消失", async () => {
    const hooks = new HookBus();
    const appended = collector(hooks, "MessageAppended");
    const orphanHistory: Message[] = [
      userMessage("读文件"),
      assistantMessage([{ type: "tool_call", id: "c1", name: "read", input: {} }]),
    ];
    const agent = new Agent({
      modelClient: textClient("摘要内容"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      initialMessages: orphanHistory,
      compactConfig: { contextWindow: 100_000, maxOutputTokens: 8192, safetyMargin: 4096, keepRecentToolResults: 5 },
    });
    const ok = await agent.compactNow();

    expect(ok).toBe(true);
    const messages = appended.events.map((e) => e.message);
    // 合成结果先补发（否则被摘要替换后在任何记录里都无迹可查），其后是摘要与恢复上下文
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: "tool_result", toolCallId: "c1", isError: true });
    expect(messages[1]).toMatchObject({ role: "user", source: "system" });
    expect(String(messages[1]!.content)).toContain("【会话摘要】");
    expect(String(messages[2]!.content)).toContain("恢复上下文");
  });

  it("命令痕迹（appendCommand）前也先补发：恢复会话首动作 /init 时轨迹顺序仍与上下文一致", async () => {
    const hooks = new HookBus();
    const appended = collector(hooks, "MessageAppended");
    const orphanHistory: Message[] = [
      userMessage("读文件"),
      assistantMessage([{ type: "tool_call", id: "c1", name: "read", input: {} }]),
    ];
    const agent = new Agent({
      modelClient: textClient("说明"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      initialMessages: orphanHistory,
    });
    // 宿主的 /init 流程：先 appendCommand 命令痕迹，再 start 走正常回合
    agent.appendCommand("/init");
    agent.start("生成项目说明");
    await drain(agent);

    const messages = appended.events.map((e) => e.message);
    // 合成结果（历史末尾）→ 命令消息 → 用户输入，与上下文顺序一致
    expect(messages[0]).toMatchObject({ role: "tool_result", toolCallId: "c1", isError: true });
    expect(messages[1]).toMatchObject({ role: "user", source: "command" });
    expect(messages[2]).toMatchObject({ role: "user", content: "生成项目说明" });
  });
});

describe("LlmCallEnd 事件：调用耗时与用量", () => {
  it("成功调用：model/durationMs/stopReason/usage/systemPrompt.hash 齐全，全文仅首次附带", async () => {
    const hooks = new HookBus();
    const ends = collector(hooks, "LlmCallEnd");
    const agent = new Agent({
      modelClient: textClient("回复"),
      modelId: "mock",
      systemPrompt: "助手提示词",
      hooks,
    });
    agent.start("第一问");
    await drain(agent);
    agent.start("第二问");
    await drain(agent);

    expect(ends.events).toHaveLength(2);
    const first = ends.events[0]!;
    expect(first.model).toBe("mock");
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    expect(first.stopReason).toBe("end_turn");
    expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(first.systemPrompt).toBeDefined();
    expect(first.systemPrompt!.hash).toBeTruthy();
    expect(first.systemPrompt!.content).toBe("助手提示词");
    // 第二次调用：hash 必带，全文不再重复
    const second = ends.events[1]!;
    expect(second.systemPrompt!.hash).toBe(first.systemPrompt!.hash);
    expect(second.systemPrompt!.content).toBeUndefined();
  });

  it("流内 error 收尾：LlmCallEnd 带 error，无 stopReason", async () => {
    const hooks = new HookBus();
    const ends = collector(hooks, "LlmCallEnd");
    const agent = new Agent({
      modelClient: {
        async *stream() {
          yield { type: "error", message: "流意外结束" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
    });
    agent.start("问题");
    await drain(agent);

    expect(ends.events).toHaveLength(1);
    expect(ends.events[0]).toMatchObject({ model: "mock", error: "流意外结束" });
    expect(ends.events[0]!.stopReason).toBeUndefined();
  });

  it("用户中断：LlmCallEnd 记「用户中断」（中断路径事件完整性）", async () => {
    const hooks = new HookBus();
    const ends = collector(hooks, "LlmCallEnd");
    const agent = new Agent({
      modelClient: {
        async *stream(_id, _ctx, options) {
          yield { type: "text_delta", text: "半截" };
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve();
            else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new DOMException("Aborted", "AbortError");
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
    });
    agent.start("问题");
    const consuming = drain(agent);
    agent.interrupt();
    await consuming;

    expect(ends.events).toHaveLength(1);
    expect(ends.events[0]).toMatchObject({ model: "mock", error: "用户中断" });
    expect(ends.events[0]!.stopReason).toBeUndefined();
  });

  it("模型链切换（reason=error）：被切模型与实际产出模型各一条 LlmCallEnd，ModelFallback 转发", async () => {
    const hooks = new HookBus();
    const ends = collector(hooks, "LlmCallEnd");
    const fallbacks = collector(hooks, "ModelFallback");
    const agent = new Agent({
      modelClient: {
        async *stream() {
          yield { type: "model_fallback", from: "main", to: "backup", reason: "error" };
          yield { type: "text_delta", text: "备选回复" };
          yield { type: "done", stopReason: "end_turn", usage: { inputTokens: 50, outputTokens: 10 } };
        },
      },
      modelId: "main",
      systemPrompt: "助手",
      hooks,
    });
    agent.start("问题");
    await drain(agent);

    expect(fallbacks.events).toEqual([{ type: "ModelFallback", agentPath: "/root", from: "main", to: "backup", reason: "error" }]);
    expect(ends.events).toHaveLength(2);
    // 主模型真实尝试过且失败：记失败调用；备选正常收口
    expect(ends.events[0]).toMatchObject({ model: "main", error: "模型调用失败，已切换备选" });
    expect(ends.events[1]).toMatchObject({ model: "backup", stopReason: "end_turn", usage: { inputTokens: 50, outputTokens: 10 } });
    expect(ends.events[1]!.error).toBeUndefined();
  });

  it("冷却跳过（reason=cooldown）：主模型未发起调用，只有备选一条 LlmCallEnd", async () => {
    const hooks = new HookBus();
    const ends = collector(hooks, "LlmCallEnd");
    const agent = new Agent({
      modelClient: {
        async *stream() {
          yield { type: "model_fallback", from: "main", to: "backup", reason: "cooldown" };
          yield { type: "text_delta", text: "备选回复" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "main",
      systemPrompt: "助手",
      hooks,
    });
    agent.start("问题");
    await drain(agent);

    expect(ends.events).toHaveLength(1);
    expect(ends.events[0]).toMatchObject({ model: "backup", stopReason: "end_turn" });
  });

  it("链上死条目跳过（reason=unresolved）：被跳过条目不发 LlmCallEnd", async () => {
    const hooks = new HookBus();
    const ends = collector(hooks, "LlmCallEnd");
    const agent = new Agent({
      modelClient: {
        async *stream() {
          yield { type: "model_fallback", from: "main", to: "ghost", reason: "unresolved" };
          yield { type: "text_delta", text: "备选回复" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "main",
      systemPrompt: "助手",
      hooks,
    });
    agent.start("问题");
    await drain(agent);

    expect(ends.events).toHaveLength(1);
    expect(ends.events[0]).toMatchObject({ model: "ghost", stopReason: "end_turn" });
  });

  it("超窗且无工具回合可剥：失败收口后原错误上抛（剥组重试的放弃分支）", async () => {
    const hooks = new HookBus();
    const ends = collector(hooks, "LlmCallEnd");
    const agent = new Agent({
      // 历史只有用户消息、无工具回合：超窗错误无法剥组重试，直接失败
      modelClient: {
        async *stream() {
          throw new Error("prompt is too long: 137500 tokens > 135000 maximum");
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
    });
    agent.start("问题");
    await expect(drain(agent)).rejects.toThrow("prompt is too long");

    expect(ends.events).toHaveLength(1);
    expect(ends.events[0]).toMatchObject({ model: "mock", error: "上下文超限且无工具回合可剥，无法重试" });
  });

  it("超窗剥组重试：每次 API 尝试独立发一条 LlmCallEnd", async () => {
    const hooks = new HookBus();
    const ends = collector(hooks, "LlmCallEnd");
    let calls = 0;
    const agent = new Agent({
      modelClient: {
        async *stream(_id, context) {
          calls++;
          if (calls === 1) {
            // 首次：带历史工具回合时抛超窗错误（触发剥组重试）
            const hasToolRound = context.messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_call"));
            if (hasToolRound) {
              throw new Error("prompt is too long: 137500 tokens > 135000 maximum");
            }
          }
          yield { type: "text_delta", text: "已读" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      tools: [makeReadTool(() => "文件内容")],
      initialMessages: [
        {
          role: "assistant",
          id: "a1",
          timestamp: new Date().toISOString(),
          content: [{ type: "tool_call", id: "old1", name: "read", input: {} }],
        },
        { role: "tool_result", id: "t1", toolCallId: "old1", toolName: "read", isError: false, content: "旧输出", timestamp: new Date().toISOString() },
      ],
    });
    agent.start("再来一次");
    await drain(agent);

    // 首次尝试超窗失败 + 剥组重试成功：两条 LlmCallEnd
    expect(ends.events).toHaveLength(2);
    expect(ends.events[0]).toMatchObject({ model: "mock", error: "上下文超限，剥组重试" });
    expect(ends.events[1]).toMatchObject({ model: "mock", stopReason: "end_turn" });
  });
});

describe("PermissionDecision 事件：权限决策镜像", () => {
  it("规则层 deny → deny/rule；规则层 allow → allow/rule", async () => {
    const hooks = new HookBus();
    const decisions = collector(hooks, "PermissionDecision");
    const agent = new Agent({
      modelClient: readToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      permission: new PermissionPipeline({ rules: [parseRuleString("read", "deny")] }),
      tools: [makeReadTool(() => "不应执行")],
    });
    agent.start("读文件");
    await drain(agent);
    expect(decisions.events).toEqual([
      { type: "PermissionDecision", agentPath: "/root", toolCallId: "c1", toolName: "read", decision: "deny", source: "rule" },
    ]);

    // 规则放行
    const hooks2 = new HookBus();
    const decisions2 = collector(hooks2, "PermissionDecision");
    const agent2 = new Agent({
      modelClient: readToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks: hooks2,
      permission: new PermissionPipeline({ rules: [parseRuleString("read", "allow")] }),
      tools: [makeReadTool(() => "文件内容")],
    });
    agent2.start("读文件");
    await drain(agent2);
    expect(decisions2.events).toEqual([
      { type: "PermissionDecision", agentPath: "/root", toolCallId: "c1", toolName: "read", decision: "allow", source: "rule" },
    ]);
  });

  it("无管线 hook 裁决：deny → deny/hook；用户审批放行 → allow/user", async () => {
    const hooks = new HookBus();
    const decisions = collector(hooks, "PermissionDecision");
    hooks.on("PreToolUse", (): "deny" => "deny");
    const agent = new Agent({
      modelClient: readToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      tools: [makeReadTool(() => "不应执行")],
    });
    agent.start("读文件");
    await drain(agent);
    expect(decisions.events).toEqual([
      { type: "PermissionDecision", agentPath: "/root", toolCallId: "c1", toolName: "read", decision: "deny", source: "hook" },
    ]);

    const hooks2 = new HookBus();
    const decisions2 = collector(hooks2, "PermissionDecision");
    const agent2 = new Agent({
      modelClient: readToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks: hooks2,
      permission: new PermissionPipeline({ rules: [], approver: async () => ({ action: "allow" }) }),
      tools: [makeReadTool(() => "文件内容")],
    });
    agent2.start("读文件");
    await drain(agent2);
    expect(decisions2.events).toEqual([
      { type: "PermissionDecision", agentPath: "/root", toolCallId: "c1", toolName: "read", decision: "allow", source: "user" },
    ]);
  });

  it("会话缓存放行归用户来源（用户「允许会话全部」的记忆）", async () => {
    const hooks = new HookBus();
    const decisions = collector(hooks, "PermissionDecision");
    let calls = 0;
    const agent = new Agent({
      // 两次工具调用：第一次走用户审批并 remember，第二次命中缓存
      modelClient: {
        async *stream(_modelId, context) {
          const results = context.messages.filter((m) => m.role === "tool_result").length;
          if (results < 2) {
            yield { type: "toolcall_start", index: 0, id: `c${results + 1}`, name: "read" };
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
      hooks,
      permission: new PermissionPipeline({
        rules: [],
        approver: async () => {
          calls++;
          return { action: "allow", remember: true };
        },
      }),
      tools: [makeReadTool(() => "文件内容")],
    });
    agent.start("读两次");
    await drain(agent);

    expect(calls).toBe(1); // 审批只发生一次
    expect(decisions.events).toHaveLength(2);
    expect(decisions.events[0]).toMatchObject({ decision: "allow", source: "user" });
    expect(decisions.events[1]).toMatchObject({ decision: "allow", source: "user" }); // 缓存命中同归用户
  });
});

describe("Compact 事件：压缩动作收口", () => {
  it("手动压缩成功：trigger=manual，ok=true，前后消息数与 token 记录", async () => {
    const hooks = new HookBus();
    const compacts = collector(hooks, "Compact");
    const agent = new Agent({
      // 摘要调用：返回固定摘要文本
      modelClient: readToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      compactConfig: { contextWindow: 100_000, maxOutputTokens: 8192, safetyMargin: 4096, keepRecentToolResults: 5 },
    });
    // 一轮完整工具回合：历史含 4 条消息（输入/工具调用/结果/总结）
    agent.start("读文件");
    await drain(agent);
    const before = agent.getMessages().length;
    const ok = await agent.compactNow();

    expect(ok).toBe(true);
    expect(compacts.events).toHaveLength(1);
    const event = compacts.events[0]!;
    expect(event.trigger).toBe("manual");
    expect(event.ok).toBe(true);
    expect(event.messagesBefore).toBe(before);
    expect(event.messagesAfter).toBeLessThan(event.messagesBefore);
    // token 前后快照已记录（极短历史下摘要文本可能长于原文，不断言大小关系）
    expect(event.tokensBefore).toBeGreaterThanOrEqual(0);
    expect(event.tokensAfter).toBeGreaterThanOrEqual(0);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("撞线自动压缩：trigger=auto（压缩触发与事件同轮发生）", async () => {
    const hooks = new HookBus();
    const compacts = collector(hooks, "Compact");
    const agent = new Agent({
      modelClient: textClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      // 可用窗口 80 token：长中文输入（200+ token）必然撞线
      compactConfig: { contextWindow: 100, maxOutputTokens: 10, safetyMargin: 10, keepRecentToolResults: 5 },
    });
    agent.start("测".repeat(300));
    await drain(agent);

    expect(compacts.events).toHaveLength(1);
    expect(compacts.events[0]!.trigger).toBe("auto");
    expect(compacts.events[0]!.ok).toBe(true);
  });

  it("摘要为空：ok=false 带 error，消息不被替换", async () => {
    const hooks = new HookBus();
    const compacts = collector(hooks, "Compact");
    const agent = new Agent({
      // 摘要调用返回空文本（只发 done 不产正文）
      modelClient: {
        async *stream() {
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      compactConfig: { contextWindow: 100_000, maxOutputTokens: 8192, safetyMargin: 4096, keepRecentToolResults: 5 },
    });
    agent.start("第一问");
    await drain(agent);
    const before = agent.getMessages();
    const ok = await agent.compactNow();

    expect(ok).toBe(false);
    expect(compacts.events).toEqual([
      expect.objectContaining({ type: "Compact", trigger: "manual", ok: false, error: "摘要结果为空" }),
    ]);
    // 失败保护：消息保持原样
    expect(agent.getMessages()).toEqual(before);
  });

  it("压缩重灌的在途消息不重发 MessageAppended（轨迹只追加不重复），摘要与恢复上下文各发一条", async () => {
    const hooks = new HookBus();
    const appended = collector(hooks, "MessageAppended");
    const agent = new Agent({
      modelClient: textClient("目标：测试压缩"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      compactConfig: { contextWindow: 100_000, maxOutputTokens: 8192, safetyMargin: 4096, keepRecentToolResults: 5 },
    });
    agent.start("第一问");
    await drain(agent);
    appended.events.length = 0;
    await agent.compactNow();

    // 压缩只新增两条消息：摘要（source: system）与恢复上下文（source: system）
    const kinds = appended.events.map((e) => ({ role: e.message.role, source: e.message.role === "user" ? e.message.source : undefined }));
    expect(kinds).toEqual([
      { role: "user", source: "system" },
      { role: "user", source: "system" },
    ]);
    expect(appended.events[0]!.message.content).toContain("【会话摘要】");
    expect(appended.events[1]!.message.content).toContain("恢复上下文");
  });
});

describe("PostToolUse durationMs：执行耗时测量", () => {
  it("执行完成的调用带 durationMs；执行前被拒的失败无 durationMs", async () => {
    const hooks = new HookBus();
    const posts = collector(hooks, "PostToolUse");
    const failures = collector(hooks, "PostToolUseFailure");
    const agent = new Agent({
      modelClient: readToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      tools: [makeReadTool(() => "文件内容")],
    });
    agent.start("读文件");
    await drain(agent);
    expect(posts.events).toHaveLength(1);
    expect(posts.events[0]!.durationMs).toBeGreaterThanOrEqual(0);

    // 权限拒绝（执行前）：失败事件不带 durationMs
    const hooks2 = new HookBus();
    const failures2 = collector(hooks2, "PostToolUseFailure");
    hooks2.on("PreToolUse", (): "deny" => "deny");
    const agent2 = new Agent({
      modelClient: readToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks: hooks2,
      tools: [makeReadTool(() => "不应执行")],
    });
    agent2.start("读文件");
    await drain(agent2);
    expect(failures2.events).toHaveLength(1);
    expect(failures2.events[0]!.durationMs).toBeUndefined();
  });

  it("执行中抛错的调用带执行窗口耗时", async () => {
    const hooks = new HookBus();
    const failures = collector(hooks, "PostToolUseFailure");
    const agent = new Agent({
      modelClient: readToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      tools: [
        makeReadTool(() => {
          throw new Error("磁盘写入失败");
        }),
      ],
    });
    agent.start("读文件");
    await drain(agent);
    expect(failures.events).toHaveLength(1);
    expect(failures.events[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});
