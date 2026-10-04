import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/agent.js";
import type { ModelClient } from "../../src/agent/agent.js";
import { AgentPath } from "../../src/agent/agent-path.js";
import { Team } from "../../src/agent/team.js";
import { HookBus } from "../../src/hooks/index.js";
import type { Tool } from "../../src/tools/index.js";

/** 毫秒睡眠（等子 agent 后台驱动收尾） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const mockTextClient: ModelClient = {
  async *stream() {
    yield { type: "text_delta", text: "ok" };
    yield { type: "done", stopReason: "end_turn" };
  },
};

function makeAgent(): Agent {
  return new Agent({ modelClient: mockTextClient, modelId: "mock", systemPrompt: "助手" });
}

describe("Team（注册表与并发限制）", () => {
  it("root 预注册，listAgents 不含 root", () => {
    const team = new Team();
    team.registerRoot(makeAgent());
    expect(team.resolveAgent(AgentPath.root())?.depth).toBe(0);
    expect(team.listAgents()).toHaveLength(0);
  });

  it("spawn 预留派生路径并可提交/释放", () => {
    const team = new Team();
    team.registerRoot(makeAgent());
    const child = team.reserveSpawn(AgentPath.root(), "task_1");
    expect(typeof child).not.toBe("string");
    const path = child as AgentPath;
    expect(path.toString()).toBe("/root/task_1");
    // 预留未提交：member 存在但 agent 为空
    expect(team.resolveAgent(path)?.agent).toBeUndefined();
    // 提交后 agent 可用
    const sub = makeAgent();
    team.commitSpawn(path, sub);
    expect(team.resolveAgent(path)?.agent).toBe(sub);
    expect(team.listAgents()).toHaveLength(1);
    // 释放后移除路径
    team.releaseSpawn(path);
    expect(team.resolveAgent(path)).toBeUndefined();
    expect(team.listAgents()).toHaveLength(0);
  });

  it("路径唯一：同名 spawn 报错", () => {
    const team = new Team();
    team.registerRoot(makeAgent());
    const child = team.reserveSpawn(AgentPath.root(), "task_1");
    expect(typeof child).not.toBe("string");
    expect(typeof team.reserveSpawn(AgentPath.root(), "task_1")).toBe("string");
  });

  it("spawn 深度上限：maxDepth 1 时深度 2 超限（守卫）", () => {
    const team = new Team({ maxDepth: 1 });
    team.registerRoot(makeAgent());
    const child = team.reserveSpawn(AgentPath.root(), "task_1");
    expect(typeof child).not.toBe("string");
    // 深度 2（task_1 再派生）超限
    expect(typeof team.reserveSpawn(child as AgentPath, "task_2")).toBe("string");
  });

  it("默认深度 2：允许树形派生孙 agent，深度 3 超限（树形协作）", () => {
    const team = new Team(); // 默认 maxDepth=2（main→子→孙）
    team.registerRoot(makeAgent());
    const child = team.reserveSpawn(AgentPath.root(), "task_1");
    expect(typeof child).not.toBe("string");
    const grand = team.reserveSpawn(child as AgentPath, "task_2"); // 深度 2（孙）允许
    expect(typeof grand).not.toBe("string");
    expect(typeof team.reserveSpawn(grand as AgentPath, "task_3")).toBe("string"); // 深度 3 超限
  });

  it("父路径不存在时 spawn 报错", () => {
    const team = new Team();
    team.registerRoot(makeAgent());
    expect(typeof team.reserveSpawn(AgentPath.parse("/root/missing") as AgentPath, "x")).toBe("string");
  });

  it("并发执行槽位：上限内可获取，超出报错，释放后可再获取", () => {
    const team = new Team({ maxConcurrent: 2 });
    const release1 = team.acquireExecution();
    const release2 = team.acquireExecution();
    expect(typeof release1).not.toBe("string");
    expect(typeof release2).not.toBe("string");
    expect(typeof team.acquireExecution()).toBe("string");
    (release1 as () => void)();
    // 释放后可再获取；重复释放幂等
    expect(typeof team.acquireExecution()).not.toBe("string");
    (release1 as () => void)();
  });

  it("interruptAll：级联中断全部子 agent（Esc 打断/退出兜底语义）", () => {
    const team = new Team();
    team.registerRoot(makeAgent());
    const child = makeAgent();
    const path = team.reserveSpawn(AgentPath.root(), "task_1") as AgentPath;
    team.commitSpawn(path, child);
    const grand = makeAgent();
    const grandPath = team.reserveSpawn(path, "task_2") as AgentPath;
    team.commitSpawn(grandPath, grand);
    team.interruptAll();
    // 所有已登记成员（子 + 孙）都被中断置位
    expect(team.resolveAgent(path)?.agent?.isInterrupted()).toBe(true);
    expect(team.resolveAgent(grandPath)?.agent?.isInterrupted()).toBe(true);
  });

  it("clear：会话收尾清空注册表（root 与全部子 agent），成员不残留", () => {
    const team = new Team();
    team.registerRoot(makeAgent());
    const path = team.reserveSpawn(AgentPath.root(), "task_1") as AgentPath;
    team.commitSpawn(path, makeAgent());
    team.clear();
    expect(team.listAgents()).toHaveLength(0);
    expect(team.resolveAgent(path)).toBeUndefined();
    expect(team.resolveAgent(AgentPath.root())).toBeUndefined();
  });

  it("clear 清空成员收件箱：排队消息不再让中断 agent 复活续跑", () => {
    const team = new Team();
    team.registerRoot(makeAgent());
    const child = makeAgent();
    const path = team.reserveSpawn(AgentPath.root(), "task_1") as AgentPath;
    team.commitSpawn(path, child);
    // 投递排队消息（不唤醒）：收件箱有内容
    void team.sendMessage(path, { type: "MESSAGE", from: AgentPath.root(), content: "hi", triggerTurn: false });
    expect(child.hasPendingMail()).toBe(true);
    team.clear();
    expect(child.hasPendingMail()).toBe(false);
  });
});

describe("子 agent 结论回灌终态口径", () => {
  it("子 agent 被中断：回灌「已中断」标记且不唤醒父", async () => {
    const hooks = new HookBus();
    const interrupted: string[] = [];
    hooks.on("AgentInterrupted", (e) => {
      interrupted.push(e.path);
    });
    const team = new Team({ hooks });
    const root = new Agent({ modelClient: mockTextClient, modelId: "mock", systemPrompt: "助手", team, hooks });
    team.registerRoot(root);
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    const child = new Agent({
      modelClient: {
        async *stream(_modelId, _context, options) {
          yield { type: "text_delta", text: "半截文本" };
          await new Promise<void>((_, reject) => {
            options?.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      team,
      hooks,
    });
    team.commitSpawn(path, child);
    await team.sendMessage(path, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "干活",
      triggerTurn: true,
    });
    await sleep(100);
    // Esc 级联中断（父同时被打断）
    child.interrupt();
    await sleep(300);

    // 中断终态：AgentInterrupted 发出；标记消息只排队不唤醒父（父闲置、零消息，
    // 唤醒会顶着打断意图重启父）
    expect(interrupted).toEqual(["/root/worker"]);
    expect(root.hasPendingMail()).toBe(true);
    expect(root.getMessages()).toHaveLength(0);
    // 父下一轮输入消费标记：模型据此知晓任务未完成，不把中途文本当结论
    root.start("继续");
    for await (const _ of root.run()) {
      // 消费事件流
    }
    const injected = root.getMessages().find(
      (m) => m.role === "user" && m.source === "system" && String(m.content).includes("已中断"),
    );
    expect(injected).toBeDefined();
    expect(String(injected?.content)).toContain("任务未完成");
  });

  it("结论命中工具调用标记特征：按不可信失败处理回灌", async () => {
    const hooks = new HookBus();
    const completed: Array<{ conclusion: string; failed?: boolean }> = [];
    hooks.on("AgentCompleted", (e) => {
      completed.push({ conclusion: e.conclusion, failed: e.failed });
    });
    const team = new Team({ hooks });
    const root = new Agent({ modelClient: mockTextClient, modelId: "mock", systemPrompt: "助手", team, hooks });
    team.registerRoot(root);
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    const child = new Agent({
      // 模型失配形态：把厂商私有工具调用标记原文吐进正文（deepseek-v4 实测样本）
      modelClient: {
        async *stream() {
          yield { type: "text_delta", text: '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read">' };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      team,
      hooks,
    });
    team.commitSpawn(path, child);
    await team.sendMessage(path, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "干活",
      triggerTurn: true,
    });
    await sleep(300);

    // 不可信失败终态：失败标记 + 明确失败文本，不再把标记原文当结论回灌父
    expect(completed).toHaveLength(1);
    expect(completed[0]!.failed).toBe(true);
    expect(completed[0]!.conclusion).toContain("不可信");
    const mail = root.getMessages().find(
      (m) => m.role === "user" && m.source === "system" && String(m.content).includes("【任务结论】"),
    );
    expect(String(mail?.content)).toContain("产出不可信");
  });

  it("子 agent 未产出正文：事件结论为空串，回灌占位说明", async () => {
    const hooks = new HookBus();
    const completed: Array<{ conclusion: string; failed?: boolean }> = [];
    hooks.on("AgentCompleted", (e) => {
      completed.push({ conclusion: e.conclusion, failed: e.failed });
    });
    const team = new Team({ hooks });
    const root = new Agent({ modelClient: mockTextClient, modelId: "mock", systemPrompt: "助手", team, hooks });
    team.registerRoot(root);
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    const child = new Agent({
      modelClient: {
        async *stream() {
          yield { type: "thinking_delta", thinking: "只想不说" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      team,
      hooks,
    });
    team.commitSpawn(path, child);
    await team.sendMessage(path, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "干活",
      triggerTurn: true,
    });
    await sleep(300);

    // 正常完成但无正文：事件保留空串（TUI 显示警示行），回灌父的是占位说明
    expect(completed).toHaveLength(1);
    expect(completed[0]!.failed).toBeUndefined();
    expect(completed[0]!.conclusion).toBe("");
    const mail = root.getMessages().find(
      (m) => m.role === "user" && m.source === "system" && String(m.content).includes("【任务结论】"),
    );
    expect(String(mail?.content)).toContain("(子代理未产出结论)");
  });

  it("结论含通用工具调用写法不误伤：正文讨论 <tool_call> 不判不可信", async () => {
    const hooks = new HookBus();
    const completed: Array<{ failed?: boolean }> = [];
    hooks.on("AgentCompleted", (e) => {
      completed.push({ failed: e.failed });
    });
    const team = new Team({ hooks });
    const root = new Agent({ modelClient: mockTextClient, modelId: "mock", systemPrompt: "助手", team, hooks });
    team.registerRoot(root);
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    const child = new Agent({
      // 通用写法正文可能合法讨论（如任务本身涉及工具调用格式），不在特征闸内
      modelClient: {
        async *stream() {
          yield { type: "text_delta", text: "适配层的 <tool_call> 解析需要处理嵌套调用" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      team,
      hooks,
    });
    team.commitSpawn(path, child);
    await team.sendMessage(path, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "干活",
      triggerTurn: true,
    });
    await sleep(300);

    expect(completed).toHaveLength(1);
    expect(completed[0]!.failed).toBeUndefined();
  });

  it("中断与不可信结论同时发生：中断分支优先，不发失败完成事件", async () => {
    const hooks = new HookBus();
    const completed: Array<{ failed?: boolean }> = [];
    hooks.on("AgentCompleted", (e) => {
      completed.push({ failed: e.failed });
    });
    const interruptedPaths: string[] = [];
    hooks.on("AgentInterrupted", (e) => {
      interruptedPaths.push(e.path);
    });
    const team = new Team({ hooks });
    const root = new Agent({ modelClient: mockTextClient, modelId: "mock", systemPrompt: "助手", team, hooks });
    team.registerRoot(root);
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    const child = new Agent({
      // 半截文本恰好含 DSML 标记：仍按中断终态处理，不落进不可信失败
      modelClient: {
        async *stream(_modelId, _context, options) {
          yield { type: "text_delta", text: "<｜｜DSML｜｜ calls> 半截" };
          await new Promise<void>((_, reject) => {
            options?.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      team,
      hooks,
    });
    team.commitSpawn(path, child);
    await team.sendMessage(path, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "干活",
      triggerTurn: true,
    });
    await sleep(100);
    child.interrupt();
    await sleep(300);

    expect(interruptedPaths).toEqual(["/root/worker"]);
    expect(completed).toHaveLength(0);
  });

  it("clear 后在途驱动才收尾：终态事件按中断补发，轨迹终态不缺口", async () => {
    const hooks = new HookBus();
    const events: Array<{ type: string; path?: string; parentPath?: string }> = [];
    hooks.on("AgentSpawned", (e) => {
      events.push({ type: "AgentSpawned", path: e.path, parentPath: e.parentPath });
    });
    hooks.on("AgentCompleted", (e) => {
      events.push({ type: "AgentCompleted", path: e.path });
    });
    hooks.on("AgentInterrupted", (e) => {
      events.push({ type: "AgentInterrupted", path: e.path, parentPath: e.parentPath });
    });
    const team = new Team({ hooks });
    const root = new Agent({ modelClient: mockTextClient, modelId: "mock", systemPrompt: "助手", team, hooks });
    team.registerRoot(root);
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    const child = new Agent({
      modelClient: {
        async *stream(_modelId, _context, options) {
          yield { type: "text_delta", text: "半截文本" };
          await new Promise<void>((_, reject) => {
            options?.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      team,
      hooks,
    });
    team.commitSpawn(path, child);
    await team.sendMessage(path, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "干活",
      triggerTurn: true,
    });
    await sleep(100);
    // 会话收尾：先中断全部成员再同步清空注册表，此时子 agent 的驱动循环仍在途
    team.clear();
    await sleep(300);

    // 迟到的终态回调查不到成员：仍按中断补发终态事件（父路径由路径结构推出），
    // 轨迹里 AgentSpawned 与 AgentInterrupted 成对，不再出现无终态行的缺口
    expect(events.some((e) => e.type === "AgentSpawned" && e.path === "/root/worker")).toBe(true);
    const interrupted = events.find((e) => e.type === "AgentInterrupted");
    expect(interrupted).toBeDefined();
    expect(interrupted!.path).toBe("/root/worker");
    expect(interrupted!.parentPath).toBe("/root");
    expect(events.some((e) => e.type === "AgentCompleted")).toBe(false);
    // 注册表已清空：不向父投递中断标记（父收件箱保持空，进程不被回灌吊住）
    expect(root.hasPendingMail()).toBe(false);
  });

  it("中断标记不顶着打断重启父：父 unwind 窗口内到达只排队，轮末不再续跑", async () => {
    let rootCalls = 0;
    // 慢工具（不响应中断，模拟 bash 收尾排水窗口）：父的轮次要等它收尾才结束
    const slowTool: Tool = {
      name: "slow",
      description: "慢工具",
      inputSchema: z.object({}),
      isReadOnly: false,
      maxResultSizeChars: 100,
      execute: () => new Promise((resolve) => setTimeout(() => resolve("工具完成"), 150)),
    };
    const hooks = new HookBus();
    const interruptedPaths: string[] = [];
    hooks.on("AgentInterrupted", (e) => {
      interruptedPaths.push(e.path);
    });
    const team = new Team({ hooks });
    const root = new Agent({
      modelClient: {
        async *stream(_modelId, ctx) {
          rootCalls++;
          if (ctx.messages.some((m) => m.role === "tool_result")) {
            yield { type: "text_delta", text: "收尾" };
            yield { type: "done", stopReason: "end_turn" };
            return;
          }
          yield { type: "toolcall_start", index: 0, id: "c1", name: "slow" };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_use" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [slowTool],
      team,
      hooks,
    });
    team.registerRoot(root);
    const path = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    const child = new Agent({
      modelClient: {
        async *stream(_modelId, _context, options) {
          yield { type: "text_delta", text: "半截" };
          await new Promise<void>((_, reject) => {
            options?.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      team,
      hooks,
    });
    team.commitSpawn(path, child);
    // 父派活后继续跑自己的轮次（工具窗口 150ms）；子同时被驱动并在流中挂起
    const rootRun = (async () => {
      root.start("干活");
      for await (const _ of root.run()) {
        // 消费事件流
      }
    })();
    await team.sendMessage(path, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "干活",
      triggerTurn: true,
    });
    await sleep(50);
    // Esc 级联：父子同时被中断。子先收尾，中断标记随即落进父收件箱，
    // 此刻父仍在工具窗口内（unwind 未结束）
    team.interruptAll();
    await rootRun;
    await sleep(200);

    // 子按中断回灌，标记只排队；父被打断后保持终态退出，不再发起新模型调用
    expect(interruptedPaths).toEqual(["/root/worker"]);
    expect(rootCalls).toBe(1);
    expect(root.hasPendingMail()).toBe(true);
    // 父下次输入消费标记
    root.start("继续");
    for await (const _ of root.run()) {
      // 消费事件流
    }
    const injected = root.getMessages().find(
      (m) => m.role === "user" && m.source === "system" && String(m.content).includes("已中断"),
    );
    expect(injected).toBeDefined();
  });
});
