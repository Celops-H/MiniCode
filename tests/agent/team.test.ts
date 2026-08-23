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

  it("spawn 深度上限（默认 1 层）", () => {
    const team = new Team();
    team.registerRoot(makeAgent());
    const child = team.reserveSpawn(AgentPath.root(), "task_1");
    expect(typeof child).not.toBe("string");
    // 深度 2（task_1 再派生）超限
    expect(typeof team.reserveSpawn(child as AgentPath, "task_2")).toBe("string");
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
});