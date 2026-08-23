import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import { AgentPath } from "../../src/agent/agent-path.js";
import { Mailbox, formatMailMessage } from "../../src/agent/mailbox.js";
import { Team } from "../../src/agent/team.js";
import type { ModelClient } from "../../src/agent/agent.js";

function makeAgent(): Agent {
  return new Agent({ modelClient: mockTextClient(), modelId: "mock", systemPrompt: "助手" });
}

function mockTextClient(): ModelClient {
  return {
    async *stream() {
      yield { type: "text_delta", text: "ok" };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

describe("Mailbox（agent 邮箱）", () => {
  it("入队 / runnable 判定 / 排空", () => {
    const mailbox = new Mailbox();
    expect(mailbox.hasPending()).toBe(false);
    mailbox.enqueue({
      type: "MESSAGE",
      from: AgentPath.root(),
      content: "你好",
      triggerTurn: false,
    });
    expect(mailbox.hasPending()).toBe(true);
    const drained = mailbox.drain();
    expect(drained).toHaveLength(1);
    expect(mailbox.hasPending()).toBe(false);
  });

  it("triggerTurn 判定（唤醒型消息）", () => {
    const mailbox = new Mailbox();
    expect(mailbox.hasTriggerTurn()).toBe(false);
    mailbox.enqueue({
      type: "MESSAGE",
      from: AgentPath.root(),
      content: "排队",
      triggerTurn: false,
    });
    expect(mailbox.hasTriggerTurn()).toBe(false);
    mailbox.enqueue({
      type: "FINAL_ANSWER",
      from: AgentPath.root(),
      content: "结论",
      triggerTurn: true,
    });
    expect(mailbox.hasTriggerTurn()).toBe(true);
  });

  it("formatMailMessage 按类型格式化", () => {
    expect(formatMailMessage({ type: "MESSAGE", from: AgentPath.root(), content: "hi", triggerTurn: false }))
      .toBe("【消息】from /root:\nhi");
    expect(formatMailMessage({ type: "NEW_TASK", from: AgentPath.root(), content: "任务", triggerTurn: true }))
      .toBe("【新任务】from /root:\n任务");
    expect(formatMailMessage({ type: "FINAL_ANSWER", from: AgentPath.root(), content: "结论", triggerTurn: true }))
      .toBe("【任务结论】from /root:\n结论");
  });
});

describe("Agent 邮箱集成与消息注入", () => {
  it("deliver 后 hasPendingMail 为真；runTurn 把消息以 source:system 注入上下文", async () => {
    let sawSystem = false;
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          sawSystem = context.messages.some(
            (m) => m.role === "user" && m.source === "system" && m.content.includes("【消息】"),
          );
          yield { type: "text_delta", text: "收到" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
    });
    agent.deliver({
      type: "MESSAGE",
      from: AgentPath.root(),
      content: "你好",
      triggerTurn: false,
    });
    expect(agent.hasPendingMail()).toBe(true);
    agent.start("跑");
    for await (const _ of agent.run()) {
      // 消费
    }
    expect(sawSystem).toBe(true);
    expect(agent.hasPendingMail()).toBe(false);
  });

  it("已结束 agent 收到唤醒消息（triggerTurn）后续跑，消息注入新一轮上下文", async () => {
    let calls = 0;
    let secondContextHasMail = false;
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          calls++;
          if (calls === 2) {
            secondContextHasMail = context.messages.some(
              (m) => m.role === "user" && m.source === "system" && m.content.includes("【新任务】"),
            );
          }
          yield { type: "text_delta", text: `回复${calls}` };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
    });
    // 第一轮：跑完一轮，模型回复无工具调用 → 会话结束（stopped）
    agent.start("第一次");
    for await (const _ of agent.run()) {
      // 消费
    }
    expect(calls).toBe(1);

    // 投递唤醒消息后再次 run：续跑，消息注入新一轮上下文
    agent.deliver({
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "继续干活",
      triggerTurn: true,
    });
    for await (const _ of agent.run()) {
      // 消费
    }
    expect(calls).toBe(2);
    expect(secondContextHasMail).toBe(true);
  });

  it("空闲 agent 收到非唤醒消息不自动续跑，用户再次 run 时一并消费", async () => {
    let calls = 0;
    let secondContextHasMail = false;
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          calls++;
          if (calls === 2) {
            secondContextHasMail = context.messages.some(
              (m) => m.role === "user" && m.source === "system" && m.content.includes("【消息】"),
            );
          }
          yield { type: "text_delta", text: "ok" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
    });
    agent.start("第一次");
    for await (const _ of agent.run()) {
      // 消费
    }
    expect(calls).toBe(1);
    // 投递非唤醒消息：空闲不自动续跑（消息滞留）
    agent.deliver({
      type: "MESSAGE",
      from: AgentPath.root(),
      content: "排队",
      triggerTurn: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    expect(agent.hasPendingMail()).toBe(true);
    // 用户再次 run：排队消息一并消费注入
    agent.start("继续");
    for await (const _ of agent.run()) {
      // 消费
    }
    expect(calls).toBe(2);
    expect(secondContextHasMail).toBe(true);
    expect(agent.hasPendingMail()).toBe(false);
  });
});

describe("Team 投递与唤醒驱动", () => {
  it("sendMessage 投递到注册 agent，目标不存在返回错误", async () => {
    const team = new Team();
    const root = makeAgent();
    team.registerRoot(root);
    const child = makeAgent();
    const path = team.reserveSpawn(AgentPath.root(), "task_1") as AgentPath;
    team.commitSpawn(path, child);

    // 非唤醒消息：入队不驱动，消息留收件箱
    const error = await team.sendMessage(path, {
      type: "MESSAGE",
      from: AgentPath.root(),
      content: "你好",
      triggerTurn: false,
    });
    expect(error).toBeUndefined();
    expect(child.hasPendingMail()).toBe(true);

    const missing = await team.sendMessage(AgentPath.parse("/root/none") as AgentPath, {
      type: "MESSAGE",
      from: AgentPath.root(),
      content: "x",
      triggerTurn: false,
    });
    expect(missing).toContain("不存在");
  });

  it("唤醒消息投递后自动驱动已结束的子 agent 续跑", async () => {
    const team = new Team();
    const root = makeAgent();
    team.registerRoot(root);
    let calls = 0;
    let sawMail = false;
    const child = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          calls++;
          sawMail = context.messages.some(
            (m) => m.role === "user" && m.source === "system" && m.content.includes("【新任务】"),
          );
          yield { type: "text_delta", text: `回复${calls}` };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
    });
    const path = team.reserveSpawn(AgentPath.root(), "task_1") as AgentPath;
    team.commitSpawn(path, child);

    // 子 agent 先跑完一轮（无工具调用 → 会话结束）
    child.start("干活");
    for await (const _ of child.run()) {
      // 消费
    }
    expect(calls).toBe(1);

    // 投递唤醒消息：自动驱动续跑（无需手动再调 run）
    await team.sendMessage(path, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "继续",
      triggerTurn: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 30)); // 等后台驱动完成
    expect(calls).toBe(2);
    expect(sawMail).toBe(true);
    expect(child.hasPendingMail()).toBe(false);
  });

  it("并发满时唤醒投递进待驱动队列，槽位释放后自动驱动", async () => {
    const team = new Team({ maxConcurrent: 1 });
    const root = makeAgent();
    team.registerRoot(root);
    // 慢模型：占用唯一并发槽位
    let slowCalls = 0;
    const slow = new Agent({
      modelClient: {
        async *stream() {
          slowCalls++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
    });
    const slowPath = team.reserveSpawn(AgentPath.root(), "slow") as AgentPath;
    team.commitSpawn(slowPath, slow);

    let fastCalls = 0;
    const fast = new Agent({
      modelClient: {
        async *stream() {
          fastCalls++;
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
    });
    const fastPath = team.reserveSpawn(AgentPath.root(), "fast") as AgentPath;
    team.commitSpawn(fastPath, fast);

    // 第一个唤醒投递占住唯一并发槽位（驱动进行中）
    await team.sendMessage(slowPath, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "慢活",
      triggerTurn: true,
    });
    // 第二个唤醒投递：并发满 → 进待驱动队列
    await team.sendMessage(fastPath, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "快活",
      triggerTurn: true,
    });
    // 等待 slow 跑完释放槽位 → 重试队列驱动 fast
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(slowCalls).toBe(1); // 唯一并发槽位，只能跑一轮
    expect(fastCalls).toBe(1); // 槽位释放后自动驱动
    expect(fast.hasPendingMail()).toBe(false); // 消息已消费
  });

  it("忙（活跃续跑循环中）时投递排队消息不重复驱动，活跃循环自行消费", async () => {
    const team = new Team();
    const root = makeAgent();
    team.registerRoot(root);
    let calls = 0;
    let sawMail = false;
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          calls++;
          if (calls === 2) {
            sawMail = context.messages.some(
              (m) => m.role === "user" && m.source === "system" && m.content.includes("【消息】"),
            );
          }
          // 第一次调用挂起 50ms，模拟模型流进行中收到投递
          if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 50));
          yield { type: "text_delta", text: `回复${calls}` };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
    });
    const path = team.reserveSpawn(AgentPath.root(), "task_1") as AgentPath;
    team.commitSpawn(path, agent);

    // 用户驱动 run()（活跃循环进行中）
    agent.start("第一问");
    const runPromise = (async () => {
      for await (const _ of agent.run()) {
        // 消费
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 20)); // 等模型第一次调用挂起
    // 此时 agent 忙（活跃循环中）：投递排队消息（非唤醒），不应启动第二个并发循环
    const error = await team.sendMessage(path, {
      type: "MESSAGE",
      from: AgentPath.root(),
      content: "中途消息",
      triggerTurn: false,
    });
    expect(error).toBeUndefined();
    await runPromise;

    // 活跃循环在每轮结束因收件箱非空继续：模型被调用 2 次，排队消息注入第二轮
    expect(calls).toBe(2);
    expect(sawMail).toBe(true);
    expect(agent.hasPendingMail()).toBe(false);
  });
});