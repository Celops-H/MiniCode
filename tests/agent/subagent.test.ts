import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import { PermissionPipeline, parseRuleString } from "../../src/permission/index.js";
import type { PermissionApprover } from "../../src/permission/index.js";

// 测试用的 bash 工具：子代理工具调用走权限校验后执行
const mockBashTool = {
  name: "bash",
  description: "执行命令",
  inputSchema: z.object({ command: z.string() }),
  isReadOnly: false,
  requiresUserInteraction: false,
  maxResultSizeChars: 30000,
  async execute(input: { command: string }) {
    return `echo: ${input.command}`;
  },
};

describe("subagent 子代理", () => {
  it("主代理调用 subagent 工具，子代理独立上下文执行并回传结论文本", async () => {
    // 脚本化客户端：子代理上下文直接给结论；父上下文先调 subagent，拿到结论后总结
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        if (context.systemPrompt.includes("子代理")) {
          yield { type: "text_delta", text: "结论：文件列表是 a.ts、b.ts" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        const hasResult = context.messages.some((m) => m.role === "tool_result");
        if (!hasResult) {
          yield { type: "toolcall_start", index: 0, id: "s1", name: "subagent" };
          yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ prompt: "查一下文件列表" }) };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
        } else {
          yield { type: "text_delta", text: "已收到子代理结论" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const agent = new Agent({
      modelClient,
      modelId: "mock",
      systemPrompt: "助手",
      subagent: true,
    });
    agent.start("帮我查文件");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    // 父消息链：user → assistant(调用 subagent) → tool_result(结论) → assistant(总结)
    const messages = agent.getMessages();
    expect(messages).toHaveLength(4);
    const result = messages.find((m) => m.role === "tool_result");
    expect(result?.content).toBe("结论：文件列表是 a.ts、b.ts");
  });

  it("只回传结论：子代理内部过程不进入父上下文", async () => {
    // 子代理内部先调一个不存在的 read 工具（回灌未知工具错误），再总结；
    // 该内部过程应留在子代理上下文，父上下文只看到最终结论
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        if (context.systemPrompt.includes("子代理")) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "read" };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "结论：read 不可用，改用目录列表" };
            yield { type: "done", stopReason: "end_turn" };
          }
          return;
        }
        const hasResult = context.messages.some((m) => m.role === "tool_result");
        if (!hasResult) {
          yield { type: "toolcall_start", index: 0, id: "s1", name: "subagent" };
          yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ prompt: "查一下文件" }) };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
        } else {
          yield { type: "text_delta", text: "总结" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const agent = new Agent({
      modelClient,
      modelId: "mock",
      systemPrompt: "助手",
      subagent: true,
    });
    agent.start("查文件");
    for await (const _ of agent.run()) {
      // 消费
    }

    const messages = agent.getMessages();
    // 父上下文只有 4 条消息，不包含子代理内部折腾（未知工具回灌）产生的内容
    expect(messages).toHaveLength(4);
    const result = messages.find((m) => m.role === "tool_result");
    expect(result?.content).toBe("结论：read 不可用，改用目录列表");
    expect(messages.some((m) => "content" in m && typeof m.content === "string" && m.content.includes("未知工具"))).toBe(
      false,
    );
  });

  it("子代理未产出文本结论时返回占位说明", async () => {
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        if (context.systemPrompt.includes("子代理")) {
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        const hasResult = context.messages.some((m) => m.role === "tool_result");
        if (!hasResult) {
          yield { type: "toolcall_start", index: 0, id: "s1", name: "subagent" };
          yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ prompt: "查文件" }) };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
        } else {
          yield { type: "text_delta", text: "总结" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const agent = new Agent({
      modelClient,
      modelId: "mock",
      systemPrompt: "助手",
      subagent: true,
    });
    agent.start("查文件");
    for await (const _ of agent.run()) {
      // 消费
    }

    const result = agent.getMessages().find((m) => m.role === "tool_result");
    expect(result?.content).toBe("(子代理未产出结论)");
  });

  it("子代理步数上限截断：不总结时最多跑 subagentMaxTurns 轮", async () => {
    let subagentCalls = 0;
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        if (context.systemPrompt.includes("子代理")) {
          subagentCalls++;
          // 永远请求工具（不存在的 read），直到被 maxTurns 截断
          yield { type: "toolcall_start", index: 0, id: "c1", name: "read" };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "总结" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const agent = new Agent({
      modelClient,
      modelId: "mock",
      systemPrompt: "助手",
      subagent: true,
      subagentMaxTurns: 3,
    });
    agent.start("查文件");
    for await (const _ of agent.run()) {
      // 消费
    }

    // 子代理最多被模型调用 3 轮后截断（含截断前最后一轮），不会无限执行
    expect(subagentCalls).toBeLessThanOrEqual(4);
  });

  it("子代理工具集不含 subagent，无法再派生子代理", async () => {
    let subagentSeenToolResult = "";
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        if (context.systemPrompt.includes("子代理")) {
          const result = context.messages.find((m) => m.role === "tool_result");
          if (!result) {
            // 子代理尝试再派生子代理，应收到未知工具错误
            yield { type: "toolcall_start", index: 0, id: "g1", name: "subagent" };
            yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ prompt: "再分派" }) };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            subagentSeenToolResult = (result as { content: string }).content;
            yield { type: "text_delta", text: "结论：无法再分派" };
            yield { type: "done", stopReason: "end_turn" };
          }
          return;
        }
        const hasResult = context.messages.some((m) => m.role === "tool_result");
        if (!hasResult) {
          yield { type: "toolcall_start", index: 0, id: "s1", name: "subagent" };
          yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ prompt: "查文件" }) };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
        } else {
          yield { type: "text_delta", text: "总结" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const agent = new Agent({
      modelClient,
      modelId: "mock",
      systemPrompt: "助手",
      subagent: true,
    });
    agent.start("查文件");
    for await (const _ of agent.run()) {
      // 消费
    }

    // 子代理请求 subagent 工具时被回灌"未知工具"，说明该工具不在子代理工具集中
    expect(subagentSeenToolResult).toContain("未知工具：subagent");
  });

  it("子代理受父会话规则约束：父 deny 规则拦截子代理工具调用", async () => {
    let subagentSeenPermission = "";
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        if (context.systemPrompt.includes("子代理")) {
          const toolResult = context.messages.find((m) => m.role === "tool_result");
          if (!toolResult) {
            yield { type: "toolcall_start", index: 0, id: "b1", name: "bash" };
            yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ command: "rm -rf /tmp/x" }) };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            subagentSeenPermission = (toolResult as { content: string }).content;
            yield { type: "text_delta", text: "结论：已了解限制" };
            yield { type: "done", stopReason: "end_turn" };
          }
          return;
        }
        const hasResult = context.messages.some((m) => m.role === "tool_result");
        if (!hasResult) {
          yield { type: "toolcall_start", index: 0, id: "s1", name: "subagent" };
          yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ prompt: "清理临时文件" }) };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
        } else {
          yield { type: "text_delta", text: "总结" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const agent = new Agent({
      modelClient,
      modelId: "mock",
      systemPrompt: "助手",
      subagent: true,
      tools: [mockBashTool],
      permission: new PermissionPipeline({
        rules: [parseRuleString("subagent", "allow"), parseRuleString("bash", "deny")],
      }),
    });
    agent.start("清理临时文件");
    for await (const _ of agent.run()) {
      // 消费
    }

    // 子代理的 bash 调用被父规则拒绝，绕不开父会话的权限约束
    expect(subagentSeenPermission).toContain("权限拒绝：规则拒绝");
  });

  it("子代理审批冒泡到父会话：ask 走父管线的用户审批", async () => {
    let approverCalls = 0;
    const approver: PermissionApprover = async () => {
      approverCalls++;
      return { action: "allow" };
    };
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        if (context.systemPrompt.includes("子代理")) {
          const toolResult = context.messages.find((m) => m.role === "tool_result");
          if (!toolResult) {
            yield { type: "toolcall_start", index: 0, id: "b1", name: "bash" };
            yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ command: "echo hi" }) };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "结论：命令已执行" };
            yield { type: "done", stopReason: "end_turn" };
          }
          return;
        }
        const hasResult = context.messages.some((m) => m.role === "tool_result");
        if (!hasResult) {
          yield { type: "toolcall_start", index: 0, id: "s1", name: "subagent" };
          yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ prompt: "执行一条命令" }) };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
        } else {
          yield { type: "text_delta", text: "总结" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const agent = new Agent({
      modelClient,
      modelId: "mock",
      systemPrompt: "助手",
      subagent: true,
      tools: [mockBashTool],
      permission: new PermissionPipeline({
        rules: [parseRuleString("subagent", "allow")],
        approver,
      }),
    });
    agent.start("执行一条命令");
    for await (const _ of agent.run()) {
      // 消费
    }

    // 子代理的 ask 审批冒泡到父会话的同一用户审批，不产生独立的审批链路
    expect(approverCalls).toBe(1);
  });
});