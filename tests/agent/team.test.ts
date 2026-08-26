import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import { AgentPath } from "../../src/agent/agent-path.js";
import { Team } from "../../src/agent/team.js";
import type { ModelClient } from "../../src/agent/agent.js";

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
    // 释放后移除并退回计数
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

  it("默认深度 2：允许树形派生孙 agent，深度 3 超限（P4-4 树形协作）", () => {
    const team = new Team(); // 默认 maxDepth=2（main→子→孙）
    team.registerRoot(makeAgent());
    const child = team.reserveSpawn(AgentPath.root(), "task_1");
    expect(typeof child).not.toBe("string");
    const grand = team.reserveSpawn(child as AgentPath, "task_2"); // 深度 2（孙）允许
    expect(typeof grand).not.toBe("string");
    expect(typeof team.reserveSpawn(grand as AgentPath, "task_3")).toBe("string"); // 深度 3 超限
  });

  it("默认派生总数 15：第 16 个超限（P4-4）", () => {
    const team = new Team(); // 默认 maxAgents=15（root 不计）
    team.registerRoot(makeAgent());
    for (let i = 0; i < 15; i++) {
      expect(typeof team.reserveSpawn(AgentPath.root(), `a${i}`)).not.toBe("string");
    }
    expect(typeof team.reserveSpawn(AgentPath.root(), "overflow")).toBe("string");
  });

  it("spawn 总数上限", () => {
    const team = new Team({ maxAgents: 2 });
    team.registerRoot(makeAgent());
    const a = team.reserveSpawn(AgentPath.root(), "a");
    const b = team.reserveSpawn(AgentPath.root(), "b");
    expect(typeof a).not.toBe("string");
    expect(typeof b).not.toBe("string");
    expect(typeof team.reserveSpawn(AgentPath.root(), "c")).toBe("string");
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
});