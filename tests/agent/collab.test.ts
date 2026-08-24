import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/agent.js";
import { HookBus } from "../../src/hooks/index.js";
import { AgentPath } from "../../src/agent/agent-path.js";
import { Team } from "../../src/agent/team.js";
import { PermissionPipeline, parseRuleString } from "../../src/permission/index.js";
import { createCollaborationTools } from "../../src/tools/index.js";
import type { Tool } from "../../src/tools/base.js";
import type { ModelClient } from "../../src/agent/agent.js";

/** 直接构造协作工具（守卫/等待逻辑只依赖 team 状态与当前路径，与 Agent 内注册的同一实现） */
function collabTool(team: Team, name: string, agentPath?: () => AgentPath | undefined): Tool {
  const tools = createCollaborationTools({
    team,
    getAgentPath: agentPath ?? (() => undefined),
    createChildAgent: () => {
      throw new Error("该测试未走 createChildAgent 路径");
    },
    sendMessage: (target, mail) => team.sendMessage(target, mail),
  });
  return tools.find((t) => t.name === name)!;
}

/** 毫秒睡眠（等待后台驱动 / 模拟耗时工具） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/** 按调用轮次切换行为的 mock：先调一次工具，拿到结果后总结 */
function toolThenTextClient(toolName: string, input: Record<string, unknown>, text = "完成"): ModelClient {
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

/** 检查传给模型的第一轮工具列表中是否有指定工具 */
function clientWithToolCheck(toolName: string): { client: ModelClient; toolsSeen: string[] } {
  const toolsSeen: string[] = [];
  const client: ModelClient = {
    async *stream(_modelId, context) {
      toolsSeen.push(...context.tools.map((t) => t.name));
      yield { type: "text_delta", text: "ok" };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
  return { client, toolsSeen };
}

describe("协作工具集（多 agent 环境）", () => {
  it("无 team 时协作工具不可见；有 team 时才注册", async () => {
    const { client: plainClient, toolsSeen: plainTools } = clientWithToolCheck("spawn_agent");
    const plain = new Agent({ modelClient: plainClient, modelId: "mock", systemPrompt: "助手" });
    plain.start("hi");
    for await (const _ of plain.run()) {
      // 消费
    }
    expect(plainTools).not.toContain("spawn_agent");

    const team = new Team();
    const { client: teamClient, toolsSeen: teamTools } = clientWithToolCheck("spawn_agent");
    const root = new Agent({ modelClient: teamClient, modelId: "mock", systemPrompt: "助手", team });
    team.registerRoot(root);
    root.start("hi");
    for await (const _ of root.run()) {
      // 消费
    }
    expect(teamTools).toContain("spawn_agent");
    expect(teamTools).toContain("send_message");
    expect(teamTools).toContain("followup_task");
    expect(teamTools).toContain("list_agents");
  });

  it("spawn_agent：派生子 agent、下达 NEW_TASK、返回路径", async () => {
    const team = new Team();
    let childResult = "";
    const root = new Agent({
      modelClient: toolThenTextClient("spawn_agent", { agentName: "worker", prompt: "检查测试目录" }),
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    team.registerRoot(root);
    root.start("派个活");
    for await (const _ of root.run()) {
      // 消费
    }
    const result = root.getMessages().find((m) => m.role === "tool_result");
    if (typeof result?.content === "string") childResult = result.content;

    expect(childResult).toContain("已派生 /root/worker");
    const worker = team.resolveAgent(AgentPath.parse("/root/worker") as AgentPath);
    expect(worker?.agent).toBeDefined();
    expect(worker?.agent?.agentPath?.toString()).toBe("/root/worker");
    expect(worker?.depth).toBe(1);
    // NEW_TASK 已投递并被子 agent 消费注入（【新任务】from /root）
    expect(
      worker?.agent?.getMessages().some(
        (m) => m.role === "user" && m.source === "system" && m.content.includes("【新任务】"),
      ),
    ).toBe(true);
  });

  it("spawn_agent：深度守卫拒绝嵌套派生", async () => {
    const team = new Team();
    // 直接经工具执行路径验证：子 agent 的协作工具在深度 2 时被拒绝
    let childToolResult = "";
    const root = new Agent({
      modelClient: toolThenTextClient("spawn_agent", { agentName: "worker", prompt: "第一层" }),
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    team.registerRoot(root);
    root.start("派活");
    for await (const _ of root.run()) {
      // 消费
    }
    const worker = team.resolveAgent(AgentPath.parse("/root/worker") as AgentPath);
    // 深度 2 派生：子 agent 场景下 spawn_agent 执行被深度守卫拒绝（getAgentPath 返回子 agent 路径）
    const spawnTool = collabTool(team, "spawn_agent", () => AgentPath.parse("/root/worker") as AgentPath);
    const second = await spawnTool.execute({ agentName: "grand", prompt: "第二层" });
    expect(typeof second).toBe("string");
    expect(second as string).toContain("深度超限");
    expect(team.resolveAgent(AgentPath.parse("/root/worker/grand") as AgentPath)).toBeUndefined();
  });

  it("send_message：排队投递不唤醒（收件箱有消息但无驱动）", async () => {
    const team = new Team();
    const root = new Agent({
      modelClient: toolThenTextClient("send_message", { target: "worker", message: "你好" }),
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    team.registerRoot(root);
    // 先派生一个子 agent
    const worker = new Agent({ modelClient: toolThenTextClient("x", {}), modelId: "mock", systemPrompt: "助手", team });
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    team.commitSpawn(path, worker);

    root.start("发消息");
    for await (const _ of root.run()) {
      // 消费
    }
    const result = root.getMessages().find((m) => m.role === "tool_result");
    expect(typeof result?.content).toBe("string");
    expect(String(result?.content)).toContain("已发送给 /root/worker");
    expect(worker.hasPendingMail()).toBe(true);
  });

  it("followup_task：投递并唤醒（驱动目标续跑）", async () => {
    const team = new Team();
    let workerCalls = 0;
    const worker = new Agent({
      modelClient: {
        async *stream() {
          workerCalls++;
          yield { type: "text_delta", text: `worker${workerCalls}` };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    const root = new Agent({
      modelClient: toolThenTextClient("followup_task", { target: "worker", message: "继续干" }),
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    team.registerRoot(root);
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    team.commitSpawn(path, worker);

    root.start("派后续");
    for await (const _ of root.run()) {
      // 消费
    }
    // followup_task 唤醒 worker：其模型被驱动调用
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(workerCalls).toBe(1);
    expect(worker.hasPendingMail()).toBe(false);
  });

  it("list_agents：列出团队成员", async () => {
    const team = new Team();
    const root = new Agent({
      modelClient: toolThenTextClient("list_agents", {}),
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    team.registerRoot(root);
    const worker = new Agent({ modelClient: toolThenTextClient("x", {}), modelId: "mock", systemPrompt: "助手", team });
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    team.commitSpawn(path, worker);

    root.start("看看团队");
    for await (const _ of root.run()) {
      // 消费
    }
    const result = root.getMessages().find((m) => m.role === "tool_result");
    expect(String(result?.content)).toContain("/root/worker");
  });

  it("send_message：目标不存在 / 绝对路径 / 空消息错误回灌", async () => {
    const team = new Team();
    const root = new Agent({
      modelClient: toolThenTextClient("send_message", { target: "worker", message: "hi" }),
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    team.registerRoot(root);
    root.start("发");
    for await (const _ of root.run()) {
      // 消费
    }
    const result = root.getMessages().find((m) => m.role === "tool_result");
    // worker 未派生：目标不存在回灌错误
    expect(String(result?.content)).toContain("不存在");

    // 绝对路径目标：派生 worker 后可用 /root/worker 引用
    const worker = new Agent({ modelClient: toolThenTextClient("x", {}), modelId: "mock", systemPrompt: "助手", team });
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    team.commitSpawn(path, worker);
    const tool = collabTool(team, "send_message");
    expect(await tool.execute({ target: "/root/worker", message: "绝对路径" })).toContain("已发送给 /root/worker");
    expect(await tool.execute({ target: "worker", message: "   " })).toContain("不能为空");
    expect(await tool.execute({ target: "Bad/Name", message: "x" })).toContain("agent 名");
  });

  it("spawn_agent：总数上限守卫", async () => {
    const team = new Team({ maxAgents: 1 });
    const root = new Agent({
      modelClient: toolThenTextClient("spawn_agent", { agentName: "a", prompt: "1" }),
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    team.registerRoot(root);
    root.start("派");
    for await (const _ of root.run()) {
      // 消费
    }
    const first = root.getMessages().find((m) => m.role === "tool_result");
    expect(String(first?.content)).toContain("已派生 /root/a");

    // 第二个 spawn 被总数上限拒绝
    const tool = collabTool(team, "spawn_agent");
    expect(await tool.execute({ agentName: "b", prompt: "2" })).toContain("总数超限");
    expect(team.resolveAgent(AgentPath.parse("/root/b") as AgentPath)).toBeUndefined();
  });

  it("子 agent 工具集：协作工具恰一份且其余继承", async () => {
    const team = new Team();
    // root 的 mock：每轮记录收到的工具集；第一轮 spawn，之后总结（worker 继承此 client，可记录其工具集）
    const toolsSeen: string[][] = [];
    const client: ModelClient = {
      async *stream(_modelId, context) {
        toolsSeen.push(context.tools.map((t) => t.name));
        const hasResult = context.messages.some((m) => m.role === "tool_result");
        if (!hasResult) {
          yield { type: "toolcall_start", index: 0, id: "c1", name: "spawn_agent" };
          yield {
            type: "toolcall_delta",
            index: 0,
            partialJson: JSON.stringify({ agentName: "worker", prompt: "干活" }),
          };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
        } else {
          yield { type: "text_delta", text: "完成" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const root = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      team,
      tools: [{
        name: "custom_tool",
        description: "自定义",
        inputSchema: z.object({}),
        isReadOnly: true,
        requiresUserInteraction: false,
        maxResultSizeChars: 100,
        execute: () => "ok",
      }],
    });
    team.registerRoot(root);
    root.start("派");
    for await (const _ of root.run()) {
      // 消费
    }
    const worker = team.resolveAgent(AgentPath.parse("/root/worker") as AgentPath)?.agent;
    expect(worker).toBeDefined();
    // 驱动 worker：其模型（继承 root 的 client）调用时记录 worker 的工具集
    await team.sendMessage(AgentPath.parse("/root/worker") as AgentPath, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "干活",
      triggerTurn: true,
    });
    await sleep(30);
    const workerTools: string[] = toolsSeen[2] ?? ([] as string[]);
    // 协作工具恰一份（未因 team 重复注册）
    for (const collab of ["spawn_agent", "send_message", "followup_task", "list_agents", "wait_agent", "interrupt_agent"]) {
      expect(workerTools.filter((n) => n === collab)).toHaveLength(1);
    }
    // 父的自定义工具被继承
    expect(workerTools).toContain("custom_tool");
  });

  it("权限：send_message 免审批；spawn_agent 走审批链（deny 拒绝）", async () => {
    const team = new Team();
    const permission = new PermissionPipeline({
      rules: [parseRuleString("spawn_agent", "deny"), parseRuleString("send_message", "deny")],
    });
    // send_message：skipsPermission 跳过规则层，deny 规则不生效
    const sendAgent = new Agent({
      modelClient: toolThenTextClient("send_message", { target: "worker", message: "hi" }),
      modelId: "mock",
      systemPrompt: "助手",
      team,
      permission,
    });
    team.registerRoot(sendAgent);
    const worker = new Agent({ modelClient: toolThenTextClient("x", {}), modelId: "mock", systemPrompt: "助手", team });
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    team.commitSpawn(path, worker);
    sendAgent.start("发");
    for await (const _ of sendAgent.run()) {
      // 消费
    }
    const sendResult = sendAgent.getMessages().find((m) => m.role === "tool_result");
    expect(String(sendResult?.content)).toContain("已发送给");

    // spawn_agent：走审批链，deny 拒绝
    const spawnAgent = new Agent({
      modelClient: toolThenTextClient("spawn_agent", { agentName: "worker2", prompt: "干活" }),
      modelId: "mock",
      systemPrompt: "助手",
      team,
      permission,
    });
    team.registerRoot(spawnAgent);
    spawnAgent.start("派");
    for await (const _ of spawnAgent.run()) {
      // 消费
    }
    const spawnResult = spawnAgent.getMessages().find((m) => m.role === "tool_result");
    expect(String(spawnResult?.content)).toContain("权限拒绝");
    expect(team.resolveAgent(AgentPath.parse("/root/worker2") as AgentPath)).toBeUndefined();
  });

  it("免审批工具仍受 plan 模式只读约束与 PreToolUse hook 拦截", async () => {
    const team = new Team();
    // plan 模式：send_message 不在只读集合 → 拒绝
    const planPermission = new PermissionPipeline({
      rules: [],
      mode: "plan",
      readOnlyTools: new Set(["read"]),
    });
    const planAgent = new Agent({
      modelClient: toolThenTextClient("send_message", { target: "worker", message: "hi" }),
      modelId: "mock",
      systemPrompt: "助手",
      team,
      permission: planPermission,
    });
    team.registerRoot(planAgent);
    planAgent.start("发");
    for await (const _ of planAgent.run()) {
      // 消费
    }
    const planResult = planAgent.getMessages().find((m) => m.role === "tool_result");
    expect(String(planResult?.content)).toContain("plan 模式只读");

    // PreToolUse hook deny 可拦截免审批工具（hook 检查挂在权限管线内，需配管线）
    const hooks = new HookBus();
    hooks.on("PreToolUse", async (event) => {
      if (event.toolName === "send_message") return "deny";
      return undefined;
    });
    const hookAgent = new Agent({
      modelClient: toolThenTextClient("send_message", { target: "worker", message: "hi" }),
      modelId: "mock",
      systemPrompt: "助手",
      team,
      hooks,
      permission: new PermissionPipeline({ rules: [] }),
    });
    team.registerRoot(hookAgent);
    hookAgent.start("发");
    for await (const _ of hookAgent.run()) {
      // 消费
    }
    const hookResult = hookAgent.getMessages().find((m) => m.role === "tool_result");
    expect(String(hookResult?.content)).toContain("权限拒绝");
  });

  it("watcher：子 agent 跑完自动把结论 FINAL_ANSWER 回灌父 agent", async () => {
    const team = new Team();
    let parentCalls = 0;
    const root = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          parentCalls++;
          // 第一轮 spawn，之后（含收到结论后的唤醒轮）总结
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "spawn_agent" };
            yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ agentName: "worker", prompt: "查一下" }) };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "收到" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    team.registerRoot(root);
    root.start("派活");
    for await (const _ of root.run()) {
      // 消费
    }
    // worker 子 agent：输出结论后结束
    const worker = team.resolveAgent(AgentPath.parse("/root/worker") as AgentPath)?.agent;
    expect(worker).toBeDefined();

    // 等 worker 被驱动跑完 → watcher 回灌 FINAL_ANSWER 给 root
    await new Promise((resolve) => setTimeout(resolve, 50));
    const finalMail = root
      .getMessages()
      .some(
        (m) => m.role === "user" && m.source === "system" && m.content.includes("【任务结论】"),
      );
    expect(finalMail).toBe(true);
  });

  it("wait_agent：目标空闲时立即返回，忙碌时等待完成后返回", async () => {
    const team = new Team();
    const root = new Agent({
      modelClient: toolThenTextClient("wait_agent", { target: "worker" }),
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    team.registerRoot(root);
    // worker 空闲（从未驱动）
    const worker = new Agent({ modelClient: toolThenTextClient("x", {}), modelId: "mock", systemPrompt: "助手", team });
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    team.commitSpawn(path, worker);
    root.start("等");
    for await (const _ of root.run()) {
      // 消费
    }
    const result = root.getMessages().find((m) => m.role === "tool_result");
    expect(String(result?.content)).toContain("已完成当前任务");

    // 忙碌目标：等待其完成（mock 慢 80ms）
    let busyCalls = 0;
    const busy = new Agent({
      modelClient: {
        async *stream() {
          busyCalls++;
          await new Promise((resolve) => setTimeout(resolve, 80));
          yield { type: "text_delta", text: "done" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    const busyPath = team.reserveSpawn(AgentPath.root(), "busy") as AgentPath;
    team.commitSpawn(busyPath, busy);
    const waitTool = collabTool(team, "wait_agent");
    await team.sendMessage(busyPath, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "干活",
      triggerTurn: true,
    });
    // 忙碌中：等待直到完成
    expect(await waitTool.execute({ target: "busy", timeoutMs: 1000 })).toContain("已完成当前任务");
  });

  it("wait_agent：超时返回", async () => {
    const team = new Team();
    const root = new Agent({
      modelClient: toolThenTextClient("wait_agent", { target: "worker" }),
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    team.registerRoot(root);
    // 一直忙碌的目标（慢模型 500ms，wait 100ms 超时）
    const busy = new Agent({
      modelClient: {
        async *stream() {
          await new Promise((resolve) => setTimeout(resolve, 500));
          yield { type: "text_delta", text: "done" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    const busyPath = team.reserveSpawn(AgentPath.root(), "busy") as AgentPath;
    team.commitSpawn(busyPath, busy);
    const waitTool = collabTool(team, "wait_agent");
    await team.sendMessage(busyPath, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "干活",
      triggerTurn: true,
    });
    const start = Date.now();
    expect(await waitTool.execute({ target: "busy", timeoutMs: 100 })).toContain("超时");
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });

  it("interrupt_agent：中断目标（当前 turn 结束后停止），root/自己不可中断", async () => {
    const team = new Team();
    const root = new Agent({
      modelClient: toolThenTextClient("interrupt_agent", { target: "worker" }),
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    team.registerRoot(root);
    const worker = new Agent({
      modelClient: toolThenTextClient("x", {}),
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    team.commitSpawn(path, worker);
    root.start("中断");
    for await (const _ of root.run()) {
      // 消费
    }
    const result = root.getMessages().find((m) => m.role === "tool_result");
    expect(String(result?.content)).toContain("已请求中断 /root/worker");

    // 守卫：root 不可被中断（root 也被前置的 isRoot 检查拦住，自己守卫是子 agent 场景）
    const intTool = collabTool(team, "interrupt_agent");
    expect(await intTool.execute({ target: "/root" })).toContain("不能被中断");
  });

  it("interrupt 核心语义：正在跑的 agent 被中断后当前 turn 结束即停止", async () => {
    const team = new Team();
    const root = new Agent({ modelClient: toolThenTextClient("x", {}), modelId: "mock", systemPrompt: "助手", team });
    team.registerRoot(root);
    // worker：第一轮调 read 工具（模拟耗时 100ms），拿到结果后本应总结第二轮
    let calls = 0;
    const worker = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          calls++;
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "r1", name: "read" };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "总结" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      team,
      tools: [
        {
          name: "read",
          description: "慢读",
          inputSchema: z.object({}),
          isReadOnly: true,
          requiresUserInteraction: false,
          maxResultSizeChars: 100,
          execute: async () => {
            await sleep(100);
            return "内容";
          },
        },
      ],
    });
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    team.commitSpawn(path, worker);

    // 投递任务驱动 worker；read 工具执行期间中断
    await team.sendMessage(path, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "读文件",
      triggerTurn: true,
    });
    await sleep(30); // 等 read 工具挂起
    worker.interrupt();
    await sleep(150); // 等 read 返回、turn 结束

    expect(calls).toBe(1); // 被中断：第一轮后停止，不再跑总结轮
    expect(worker.isInterrupted()).toBe(true);
  });

  it("wait_agent：不能等待自己", async () => {
    const team = new Team();
    const root = new Agent({
      modelClient: toolThenTextClient("wait_agent", { target: "worker" }),
      modelId: "mock",
      systemPrompt: "助手",
      team,
    });
    team.registerRoot(root);
    root.start("等");
    for await (const _ of root.run()) {
      // 消费
    }
const waitTool = collabTool(team, "wait_agent");
    expect(await waitTool.execute({ target: "/root" })).toContain("不能等待自己");
  });
});