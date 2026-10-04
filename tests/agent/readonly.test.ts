import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/agent.js";
import type { ModelClient } from "../../src/agent/agent.js";
import { HookBus } from "../../src/hooks/index.js";
import { AgentPath } from "../../src/agent/agent-path.js";
import { Team } from "../../src/agent/team.js";
import { PermissionPipeline, parseRuleString } from "../../src/permission/index.js";
import type { Tool } from "../../src/tools/base.js";

/** 记录执行的工具（只读拦截命中时不应出现在其中） */
function recordingTool(name: string, executed: string[], schema: "command" | "path" = "path"): Tool {
  return {
    name,
    description: name,
    inputSchema: schema === "command" ? z.object({ command: z.string() }) : z.object({ path: z.string() }),
    isReadOnly: false,
    maxResultSizeChars: 1000,
    execute: async () => {
      executed.push(name);
      return "ok";
    },
  };
}

/** 先调一次工具、拿到结果后总结的 mock 客户端 */
function toolThenText(toolName: string, input: Record<string, unknown>, text = "完成"): ModelClient {
  return {
    async *stream(_modelId, context) {
      const hasResult = context.messages.some((m) => m.role === "tool_result");
      if (!hasResult) {
        yield { type: "toolcall_start", index: 0, id: "c1", name: toolName };
        yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify(input) };
        yield { type: "toolcall_end", index: 0 };
        yield { type: "done", stopReason: "tool_calls" };
      } else {
        yield { type: "text_delta", text };
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
}

/** 最后一条工具结果回灌文本 */
function lastToolResult(agent: Agent): string {
  const results = agent.getMessages().filter((m) => m.role === "tool_result");
  return String(results.at(-1)?.content ?? "");
}

/** 跑完 agent 一轮 */
async function runOne(agent: Agent, input: string): Promise<void> {
  agent.start(input);
  for await (const _ of agent.run()) {
    // 消费
  }
}

/** 短暂等待后台驱动（子 agent 被 NEW_TASK 唤醒后跑完） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("只读 agent 写拦截", () => {
  it("写类工具（write/edit）拒绝，执行不发生；普通 agent 照常执行", async () => {
    const executed: string[] = [];
    const readonlyAgent = new Agent({
      modelClient: toolThenText("write", { path: "a.txt" }),
      modelId: "mock",
      systemPrompt: "助手",
      readOnly: true,
      tools: [recordingTool("write", executed), recordingTool("edit", executed)],
    });
    await runOne(readonlyAgent, "写文件");
    expect(lastToolResult(readonlyAgent)).toContain("只读 agent 不允许写操作");
    expect(executed).not.toContain("write");

    const normalAgent = new Agent({
      modelClient: toolThenText("write", { path: "a.txt" }),
      modelId: "mock",
      systemPrompt: "助手",
      tools: [recordingTool("write", executed)],
    });
    await runOne(normalAgent, "写文件");
    expect(lastToolResult(normalAgent)).toBe("ok");
    expect(executed).toContain("write");
  });

  it("bash 写命令拒绝（重定向/删除/提交），只读命令照常执行", async () => {
    const executed: string[] = [];
    const readonlyAgent = new Agent({
      modelClient: toolThenText("bash", { command: "git show HEAD > patch.diff" }),
      modelId: "mock",
      systemPrompt: "助手",
      readOnly: true,
      tools: [recordingTool("bash", executed, "command")],
    });
    await runOne(readonlyAgent, "看提交");
    expect(lastToolResult(readonlyAgent)).toContain("只读 agent 不允许写操作");
    expect(lastToolResult(readonlyAgent)).toContain("重定向");
    expect(executed).toHaveLength(0);

    for (const command of ["rm -rf build", "git commit -m x", "sed -i s/a/b/ f.txt"]) {
      const agent = new Agent({
        modelClient: toolThenText("bash", { command }),
        modelId: "mock",
        systemPrompt: "助手",
        readOnly: true,
        tools: [recordingTool("bash", executed, "command")],
      });
      await runOne(agent, "执行");
      expect(lastToolResult(agent), command).toContain("只读 agent 不允许写操作");
    }

    const readAgent = new Agent({
      modelClient: toolThenText("bash", { command: "git show HEAD --stat" }),
      modelId: "mock",
      systemPrompt: "助手",
      readOnly: true,
      tools: [recordingTool("bash", executed, "command")],
    });
    await runOne(readAgent, "看提交");
    expect(lastToolResult(readAgent)).toBe("ok");
    expect(executed).toContain("bash");
  });

  it("只读拦截先于权限管线：规则 allow 也不放行，决策只发一次且归 rule", async () => {
    const decisions: Array<{ toolName: string; decision: string; source: string }> = [];
    const hooks = new HookBus();
    hooks.on("PermissionDecision", (e) => {
      decisions.push({ toolName: e.toolName, decision: e.decision, source: e.source });
    });
    const executed: string[] = [];
    // 规则层显式 allow write：只读约束仍先拒（不进审批链，规则层不被咨询）
    const permission = new PermissionPipeline({ rules: [parseRuleString("write", "allow")] });
    const agent = new Agent({
      modelClient: toolThenText("write", { path: "a.txt" }),
      modelId: "mock",
      systemPrompt: "助手",
      readOnly: true,
      permission,
      hooks,
      tools: [recordingTool("write", executed)],
    });
    await runOne(agent, "写文件");
    expect(lastToolResult(agent)).toContain("只读 agent 不允许写操作");
    expect(executed).toHaveLength(0);
    expect(decisions).toEqual([{ toolName: "write", decision: "deny", source: "rule" }]);
  });

  it("spawn_agent 只读声明：子 agent 拦截写操作、提示词带只读约束、事件带 readOnly", async () => {
    const executed: string[] = [];
    const events: Array<{ path: string; readOnly?: boolean }> = [];
    const childPrompts: string[] = [];
    const hooks = new HookBus();
    hooks.on("AgentSpawned", (e) => {
      events.push({ path: e.path, readOnly: e.readOnly });
    });
    const team = new Team({ hooks });
    const root = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          // 子 agent（协作提示开头）：记录提示词后调 write（应被拦截），再收尾
          if (context.systemPrompt.startsWith("你是团队工作 agent")) {
            childPrompts.push(context.systemPrompt);
            const hasResult = context.messages.some((m) => m.role === "tool_result");
            if (!hasResult) {
              yield { type: "toolcall_start", index: 0, id: "c2", name: "write" };
              yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ path: "x.txt" }) };
              yield { type: "toolcall_end", index: 0 };
              yield { type: "done", stopReason: "tool_calls" };
            } else {
              yield { type: "text_delta", text: "审查完成" };
              yield { type: "done", stopReason: "end_turn" };
            }
            return;
          }
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "spawn_agent" };
            yield {
              type: "toolcall_delta",
              index: 0,
              partialJson: JSON.stringify({ agentName: "reviewer", prompt: "审查", readOnly: true, worktree: true }),
            };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "已派发" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      team,
      hooks,
      tools: [recordingTool("write", executed)],
    });
    team.registerRoot(root);
    await runOne(root, "派审查");
    await sleep(80);

    const reviewer = team.resolveAgent(AgentPath.parse("/root/reviewer") as AgentPath)?.agent;
    // 只读声明生效：子 agent 只读、write 被拦截未执行、提示词带只读约束段
    expect(reviewer?.isReadOnly()).toBe(true);
    expect(lastToolResult(reviewer!)).toContain("只读 agent 不允许写操作");
    expect(executed).toHaveLength(0);
    expect(childPrompts[0]).toContain("你是只读 agent");
    // root 自身不受声明影响；派生结果注明 worktree 已忽略、派生事件带 readOnly
    expect(root.isReadOnly()).toBe(false);
    expect(lastToolResult(root)).toContain("worktree 隔离已忽略");
    expect(events).toContainEqual({ path: "/root/reviewer", readOnly: true });
  });

  it("只读父强制继承：子 agent 未声明也只读，孙 agent 写操作同样被拦", async () => {
    const executed: string[] = [];
    const team = new Team();
    const root = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const isChild = context.systemPrompt.startsWith("你是团队工作 agent");
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!isChild) {
            // root：派 worker（不声明 readOnly）
            if (!hasResult) {
              yield { type: "toolcall_start", index: 0, id: "c1", name: "spawn_agent" };
              yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ agentName: "worker", prompt: "第一层" }) };
              yield { type: "toolcall_end", index: 0 };
              yield { type: "done", stopReason: "tool_calls" };
            } else {
              yield { type: "text_delta", text: "已派发" };
              yield { type: "done", stopReason: "end_turn" };
            }
            return;
          }
          // worker：再派 grand；grand：调 write（应被拦截）
          const isGrand = context.messages.some(
            (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("from /root/worker"),
          );
          if (isGrand) {
            if (!hasResult) {
              yield { type: "toolcall_start", index: 0, id: "c3", name: "write" };
              yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ path: "y.txt" }) };
              yield { type: "toolcall_end", index: 0 };
              yield { type: "done", stopReason: "tool_calls" };
            } else {
              yield { type: "text_delta", text: "grand 收尾" };
              yield { type: "done", stopReason: "end_turn" };
            }
            return;
          }
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c2", name: "spawn_agent" };
            yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ agentName: "grand", prompt: "第二层" }) };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "worker 收尾" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      team,
      readOnly: true,
      tools: [recordingTool("write", executed)],
    });
    team.registerRoot(root);
    await runOne(root, "派活");
    await sleep(150);

    // 强制继承：worker 未声明也只读；grand（孙）同样只读、write 被拦截
    const worker = team.resolveAgent(AgentPath.parse("/root/worker") as AgentPath)?.agent;
    const grand = team.resolveAgent(AgentPath.parse("/root/worker/grand") as AgentPath)?.agent;
    expect(worker?.isReadOnly()).toBe(true);
    expect(grand?.isReadOnly()).toBe(true);
    expect(lastToolResult(grand!)).toContain("只读 agent 不允许写操作");
    expect(executed).toHaveLength(0);
  });
});
