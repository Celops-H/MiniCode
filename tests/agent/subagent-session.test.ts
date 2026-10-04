import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/agent.js";
import { AgentPath } from "../../src/agent/agent-path.js";
import { Team } from "../../src/agent/team.js";
import type { ModelClient } from "../../src/agent/agent.js";
import type { Context } from "../../src/core/index.js";
import { SessionStore, type SessionMeta } from "../../src/storage/index.js";

/** 毫秒睡眠（等待后台驱动） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 父子行为分离的 mock：root（协作提示开头之外的提示词）第一轮派生 worker、第二轮总结；
 * 子 agent（系统提示词以固定协作提示开头）直接产出正文收尾，不再派生。
 */
function parentSpawnsChildClient(childText = "完成"): ModelClient {
  return {
    async *stream(_modelId, context: Context) {
      if (context.systemPrompt.startsWith("你是团队工作 agent")) {
        yield { type: "text_delta", text: childText };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }
      const hasResult = context.messages.some((m) => m.role === "tool_result");
      if (!hasResult) {
        yield { type: "toolcall_start", index: 0, id: "c1", name: "spawn_agent" };
        yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ agentName: "worker", prompt: "干活" }) };
        yield { type: "toolcall_end", index: 0 };
        yield { type: "done", stopReason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: "收到" };
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
}

describe("子 agent 会话落盘", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(): SessionStore {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-agent-session-"));
    return new SessionStore(dir);
  }

  /** 读取目录下全部子 agent 会话 meta */
  function subagentMetas(): SessionMeta[] {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".meta.json"))
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as SessionMeta)
      .filter((m) => m.kind === "subagent");
  }

  it("派生链路：子 agent 各建独立会话文件，消息与终态标记齐全，root 不落子会话", async () => {
    const store = setup();
    const team = new Team();
    const root = new Agent({
      modelClient: parentSpawnsChildClient(),
      modelId: "mock",
      systemPrompt: "助手",
      team,
      sessionId: "main-session",
      subagentStore: store,
    });
    team.registerRoot(root);
    root.start("派活");
    for await (const _ of root.run()) {
      // 消费
    }
    // worker 被 NEW_TASK 唤醒后台驱动跑完，watcher 回灌并写终态标记
    await sleep(200);

    const metas = subagentMetas();
    // 恰一个子会话，root 自己不落（/root 无子会话文件）
    expect(metas).toHaveLength(1);
    const meta = metas[0]!;
    expect(meta.parentSessionId).toBe("main-session");
    expect(meta.agentPath).toBe("/root/worker");

    const child = await store.loadSession(meta.id);
    // 子会话消息齐全：任务注入 + 结论正文（含轮间 flush 的消息）
    const contents = child.getMessages().map((m) => (m.role === "user" || m.role === "tool_result" ? m.content : ""));
    expect(contents.some((c) => typeof c === "string" && c.includes("【新任务】"))).toBe(true);
    expect(
      child
        .getMessages()
        .some((m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text === "完成")),
    ).toBe(true);
    // 会话级汇总：终态回调写过结束标记
    expect(child.meta.summary?.endedReason).toBe("completed");
    expect(child.meta.summary?.endedAt).toBeTruthy();
    expect(child.meta.summary?.messageCount).toBe(child.getMessages().length);
  });

  it("被中断的子 agent：结束标记为 interrupted，中断前的消息已落盘", async () => {
    const store = setup();
    const team = new Team();
    const root = new Agent({
      modelClient: toolThenTextClient("x", {}),
      modelId: "mock",
      systemPrompt: "助手",
      team,
      sessionId: "main-session",
      subagentStore: store,
    });
    team.registerRoot(root);
    const worker = new Agent({
      modelClient: toolThenTextClient("read", {}),
      modelId: "mock",
      systemPrompt: "助手",
      team,
      sessionId: "main-session",
      subagentStore: store,
      tools: [
        {
          name: "read",
          description: "慢读",
          inputSchema: z.object({}),
          isReadOnly: true,
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
    await team.sendMessage(path, { type: "NEW_TASK", from: AgentPath.root(), content: "读", triggerTurn: true });
    await sleep(30);
    worker.interrupt();
    await sleep(400);

    const metas = subagentMetas();
    expect(metas).toHaveLength(1);
    const child = await store.loadSession(metas[0]!.id);
    expect(child.meta.summary?.endedReason).toBe("interrupted");
    // 中断前的消息已落盘（任务注入 + 工具调用回合）
    expect(child.getMessages().some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("【新任务】"))).toBe(true);
    expect(child.getMessages().some((m) => m.role === "tool_result")).toBe(true);
  });

  it("会话收尾：clear 不覆盖已完成的结束标记；从未跑起来的子 agent 不留会话文件", async () => {
    const store = setup();
    const team = new Team();
    const root = new Agent({
      modelClient: parentSpawnsChildClient(),
      modelId: "mock",
      systemPrompt: "助手",
      team,
      sessionId: "main-session",
      subagentStore: store,
    });
    team.registerRoot(root);
    root.start("派活");
    for await (const _ of root.run()) {
      // 消费
    }
    await sleep(200);
    // worker 已完成（endedReason=completed）；再派一个从未驱动的 idle
    const idle = new Agent({
      modelClient: parentSpawnsChildClient(),
      modelId: "mock",
      systemPrompt: "助手",
      team,
      sessionId: "main-session",
      subagentStore: store,
    });
    const idlePath = team.reserveSpawn(AgentPath.root(), "idle") as AgentPath;
    team.commitSpawn(idlePath, idle);
    team.clear();
    await sleep(50);

    const metas = subagentMetas();
    // 只有跑起来的 worker 有会话文件（idle 懒建未触发，clear 也不补建）
    expect(metas).toHaveLength(1);
    expect(metas[0]!.agentPath).toBe("/root/worker");
    const child = await store.loadSession(metas[0]!.id);
    // 已完成标记不被 clear 的兜底收尾覆盖成 interrupted
    expect(child.meta.summary?.endedReason).toBe("completed");
  });

  it("派生链透传：孙 agent 同样建独立会话文件并写终态标记", async () => {
    const store = setup();
    const team = new Team();
    // root 派 worker；worker 派 grand；grand 直接收尾（按收件人消息区分 worker 与 grand）
    const client: ModelClient = {
      async *stream(_modelId, context) {
        const isCollab = context.systemPrompt.startsWith("你是团队工作 agent");
        const isGrand =
          isCollab &&
          context.messages.some(
            (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("from /root/worker"),
          );
        const hasResult = context.messages.some((m) => m.role === "tool_result");
        if (!isCollab) {
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "spawn_agent" };
            yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ agentName: "worker", prompt: "拆活" }) };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "收到" };
            yield { type: "done", stopReason: "end_turn" };
          }
          return;
        }
        if (isGrand) {
          yield { type: "text_delta", text: "孙完成" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        if (!hasResult) {
          yield { type: "toolcall_start", index: 0, id: "c2", name: "spawn_agent" };
          yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ agentName: "grand", prompt: "第二层" }) };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
        } else {
          yield { type: "text_delta", text: "worker完成" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const root = new Agent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      team,
      sessionId: "main-session",
      subagentStore: store,
    });
    team.registerRoot(root);
    root.start("派活");
    for await (const _ of root.run()) {
      // 消费
    }
    // 两级后台驱动：worker 派 grand、grand 完成回灌、worker 完成回灌
    await sleep(500);

    const metas = subagentMetas();
    expect(metas.map((m) => m.agentPath).sort()).toEqual(["/root/worker", "/root/worker/grand"]);
    // 孙会话同样归到主会话名下，终态标记齐全
    const grand = metas.find((m) => m.agentPath === "/root/worker/grand")!;
    expect(grand.parentSessionId).toBe("main-session");
    const loaded = await store.loadSession(grand.id);
    expect(loaded.meta.summary?.endedReason).toBe("completed");
  });
});

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
