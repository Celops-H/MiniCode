import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import { HookBus, type HookVerdict } from "../../src/hooks/index.js";
import { PermissionPipeline, parseRuleString } from "../../src/permission/index.js";
import type { Tool } from "../../src/tools/index.js";

function mockTextClient(text: string): ModelClient {
  return {
    async *stream() {
      yield { type: "text_delta", text };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

/** 模型先请求一次 read 工具，看到结果后总结 */
function mockReadToolClient(): ModelClient {
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

/** 模型调用一个不存在的工具（结果回灌后结束） */
function unknownToolClient(): ModelClient {
  return {
    async *stream(_modelId, context) {
      const hasResult = context.messages.some((m) => m.role === "tool_result");
      if (!hasResult) {
        yield { type: "toolcall_start", index: 0, id: "u1", name: "nope" };
        yield { type: "toolcall_end", index: 0 };
        yield { type: "done", stopReason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: "结束了" };
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
    requiresUserInteraction: false,
    maxResultSizeChars: 1000,
    execute,
  };
}

describe("Agent 接入 Hook 事件", () => {
  it("run 处理用户输入前触发 UserPromptSubmit（携带输入内容，宿主在 start 后触发）", async () => {
    const hooks = new HookBus();
    const handler = vi.fn();
    hooks.on("UserPromptSubmit", handler);
    const agent = new Agent({
      modelClient: mockTextClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
    });
    agent.start("你好");
    // 会话级 Hook 由宿主触发：每次用户输入后一次
    await hooks.emit({ type: "UserPromptSubmit", input: "你好" });
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: "UserPromptSubmit", input: "你好" });
  });

  it("多轮输入：宿主每次 start 后各触发一次 UserPromptSubmit", async () => {
    const hooks = new HookBus();
    const handler = vi.fn();
    hooks.on("UserPromptSubmit", handler);
    const agent = new Agent({
      modelClient: mockTextClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
    });
    agent.start("第一个问题");
    await hooks.emit({ type: "UserPromptSubmit", input: "第一个问题" });
    for await (const _ of agent.run()) {
      // 消费事件流
    }
    agent.start("第二个问题");
    await hooks.emit({ type: "UserPromptSubmit", input: "第二个问题" });
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, { type: "UserPromptSubmit", input: "第一个问题" });
    expect(handler).toHaveBeenNthCalledWith(2, { type: "UserPromptSubmit", input: "第二个问题" });
  });

  it("SessionStart 由宿主在会话开始时触发一次", async () => {
    const hooks = new HookBus();
    const handler = vi.fn();
    hooks.on("SessionStart", handler);
    const agent = new Agent({
      modelClient: mockTextClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
    });
    // 会话级 Hook 由宿主触发：会话开始（首次驱动前）一次
    await hooks.emit({ type: "SessionStart" });
    agent.start("第一问");
    for await (const _ of agent.run()) {
      // 消费
    }
    agent.start("第二问");
    for await (const _ of agent.run()) {
      // 消费
    }

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("无工具调用时触发 Stop，本轮对话结束", async () => {
    const hooks = new HookBus();
    const handler = vi.fn();
    hooks.on("Stop", handler);
    const agent = new Agent({
      modelClient: mockTextClient("回答完毕"),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
    });
    agent.start("问题");
    for await (const _ of agent.run()) {
      // 消费
    }

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("工具调用轮不触发 Stop，最终无工具调用的总结轮才触发一次", async () => {
    const hooks = new HookBus();
    const handler = vi.fn();
    hooks.on("Stop", handler);
    const agent = new Agent({
      modelClient: {
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
      },
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      tools: [
        {
          name: "read",
          description: "读取文件",
          inputSchema: z.object({}),
          isReadOnly: true,
          requiresUserInteraction: false,
          maxResultSizeChars: 1000,
          execute: () => "内容",
        },
      ],
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费
    }

    // 工具调用轮（第一轮）不触发；第二轮模型总结（无工具调用）触发一次
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("Agent 工具钩子事件（PreToolUse 裁决 + PostToolUse 观测）", () => {
  it("PreToolUse 返回 deny 时拒绝执行工具，回灌权限拒绝错误", async () => {
    let executed = false;
    const hooks = new HookBus();
    hooks.on("PreToolUse", (): HookVerdict => "deny");
    const agent = new Agent({
      modelClient: mockReadToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      permission: new PermissionPipeline({ rules: [] }),
      tools: [
        makeReadTool(() => {
          executed = true;
          return "不应执行";
        }),
      ],
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费
    }

    expect(executed).toBe(false);
    const result = agent.getMessages().find((m) => m.role === "tool_result");
    expect(result?.content).toContain("权限拒绝：Hook 拒绝");
  });

  it("PreToolUse 返回 allow 时放行，工具正常执行", async () => {
    const hooks = new HookBus();
    hooks.on("PreToolUse", (): HookVerdict => "allow");
    const agent = new Agent({
      modelClient: mockReadToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      permission: new PermissionPipeline({ rules: [] }),
      tools: [makeReadTool(() => "文件内容")],
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费
    }

    const result = agent.getMessages().find((m) => m.role === "tool_result");
    expect(result?.content).toBe("文件内容");
  });

  it("规则层 deny 优先于 Hook allow（DESIGN 8.1 不变量）", async () => {
    let executed = false;
    const hooks = new HookBus();
    hooks.on("PreToolUse", (): HookVerdict => "allow");
    const agent = new Agent({
      modelClient: mockReadToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      permission: new PermissionPipeline({ rules: [parseRuleString("read", "deny")] }),
      tools: [
        makeReadTool(() => {
          executed = true;
          return "不应执行";
        }),
      ],
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费
    }

    expect(executed).toBe(false);
    const result = agent.getMessages().find((m) => m.role === "tool_result");
    expect(result?.content).toContain("权限拒绝：规则拒绝");
  });

  it("PreToolUse 返回 ask 时进入用户审批", async () => {
    const approver = vi.fn().mockResolvedValue({ action: "allow" });
    const hooks = new HookBus();
    hooks.on("PreToolUse", (): HookVerdict => "ask");
    const agent = new Agent({
      modelClient: mockReadToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      permission: new PermissionPipeline({ rules: [], approver }),
      tools: [makeReadTool(() => "文件内容")],
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费
    }

    expect(approver).toHaveBeenCalledTimes(1);
    const result = agent.getMessages().find((m) => m.role === "tool_result");
    expect(result?.content).toBe("文件内容");
  });

  it("工具执行成功触发 PostToolUse（带输出与成败标记）", async () => {
    const hooks = new HookBus();
    const handler = vi.fn();
    hooks.on("PostToolUse", handler);
    const agent = new Agent({
      modelClient: mockReadToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      tools: [makeReadTool(() => "文件内容")],
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费
    }

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PostToolUse",
        toolName: "read",
        output: "文件内容",
        isError: false,
      }),
    );
  });

  it("工具执行抛错触发 PostToolUseFailure（带错误信息）", async () => {
    const hooks = new HookBus();
    const handler = vi.fn();
    hooks.on("PostToolUseFailure", handler);
    const agent = new Agent({
      modelClient: mockReadToolClient(),
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
    for await (const _ of agent.run()) {
      // 消费
    }

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PostToolUseFailure",
        toolName: "read",
        error: "磁盘写入失败",
      }),
    );
  });

  it("无权限管线时 PreToolUse 也无条件触发：deny 直接拒绝执行（review 修复：原实现依赖管线，CLI 未装配则永不触发）", async () => {
    let executed = false;
    const hooks = new HookBus();
    hooks.on("PreToolUse", (): HookVerdict => "deny");
    const agent = new Agent({
      modelClient: mockReadToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      tools: [
        makeReadTool(() => {
          executed = true;
          return "不应执行";
        }),
      ],
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费
    }

    expect(executed).toBe(false);
    const result = agent.getMessages().find((m) => m.role === "tool_result");
    expect(result?.content).toContain("权限拒绝");
  });

  it("无权限管线时 PreToolUse 无条件触发：allow 放行，工具正常执行", async () => {
    const hooks = new HookBus();
    const handler = vi.fn();
    hooks.on("PreToolUse", handler);
    hooks.on("PreToolUse", (): HookVerdict => "allow");
    const agent = new Agent({
      modelClient: mockReadToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      tools: [makeReadTool(() => "文件内容")],
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费
    }

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: "PreToolUse", toolName: "read" }));
    const result = agent.getMessages().find((m) => m.role === "tool_result");
    expect(result?.content).toBe("文件内容");
  });

  it("无权限管线时 ask 保守拒绝（无审批者）；免审批工具 ask 视为放行（与管线 checkSkipsPermission 一致）", async () => {
    // 普通工具：ask 无审批者 → 拒绝
    const hooks = new HookBus();
    hooks.on("PreToolUse", (): HookVerdict => "ask");
    let executed = false;
    const agent = new Agent({
      modelClient: mockReadToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      tools: [
        makeReadTool(() => {
          executed = true;
          return "不应执行";
        }),
      ],
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费
    }
    expect(executed).toBe(false);
    const denied = agent.getMessages().find((m) => m.role === "tool_result");
    expect(denied?.content).toContain("权限拒绝");

    // 免审批工具（skipsPermission，如 agent 消息投递）：ask 放行
    const hooks2 = new HookBus();
    hooks2.on("PreToolUse", (): HookVerdict => "ask");
    let executed2 = false;
    const agent2 = new Agent({
      modelClient: mockReadToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks: hooks2,
      tools: [
        {
          ...makeReadTool(() => {
            executed2 = true;
            return "文件内容";
          }),
          skipsPermission: true,
        },
      ],
    });
    agent2.start("读文件");
    for await (const _ of agent2.run()) {
      // 消费
    }
    expect(executed2).toBe(true);
    const allowed = agent2.getMessages().find((m) => m.role === "tool_result");
    expect(allowed?.content).toBe("文件内容");
  });

  it("工具失败路径事件闭合（此前确认）：未知工具与权限拒绝都发 PostToolUseFailure（带 toolCallId 配对）", async () => {
    // 未知工具：无 tool 可执行，发失败事件
    const hooks1 = new HookBus();
    const failure1 = vi.fn();
    hooks1.on("PostToolUseFailure", failure1);
    const agent1 = new Agent({
      modelClient: unknownToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks: hooks1,
      tools: [],
    });
    agent1.start("调未知工具");
    for await (const _ of agent1.run()) {
      // 消费
    }
    expect(failure1).toHaveBeenCalledTimes(1);
    expect(failure1).toHaveBeenCalledWith(
      expect.objectContaining({ type: "PostToolUseFailure", toolCallId: "u1", toolName: "nope", error: expect.stringContaining("未知工具") }),
    );

    // 权限拒绝（无管线 hook deny）：发失败事件
    const hooks2 = new HookBus();
    const failure2 = vi.fn();
    hooks2.on("PostToolUseFailure", failure2);
    hooks2.on("PreToolUse", (): HookVerdict => "deny");
    const agent2 = new Agent({
      modelClient: mockReadToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks: hooks2,
      tools: [makeReadTool(() => "不应执行")],
    });
    agent2.start("读文件");
    for await (const _ of agent2.run()) {
      // 消费
    }
    expect(failure2).toHaveBeenCalledTimes(1);
    expect(failure2).toHaveBeenCalledWith(
      expect.objectContaining({ type: "PostToolUseFailure", toolCallId: "c1", toolName: "read", error: expect.stringContaining("权限拒绝") }),
    );
  });

  it("工具事件带 toolCallId 配对（此前确认）：PreToolUse → PostToolUse 同一调用 id", async () => {
    const hooks = new HookBus();
    const pre = vi.fn();
    const post = vi.fn();
    hooks.on("PreToolUse", pre);
    hooks.on("PostToolUse", post);
    const agent = new Agent({
      modelClient: mockReadToolClient(),
      modelId: "mock",
      systemPrompt: "助手",
      hooks,
      tools: [makeReadTool(() => "文件内容")],
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费
    }
    expect(pre).toHaveBeenCalledWith(expect.objectContaining({ type: "PreToolUse", toolCallId: "c1" }));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "PostToolUse", toolCallId: "c1" }));
  });
});