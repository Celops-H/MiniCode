/**
 * 层 1：恢复会话重建多 agent 历史——带 agentPath 的注入消息重演为 agent 活动行
 * （结论/中断）并重建 agent 树条目，不再以「你」消息块铺全文；老数据无 agentPath
 * 字段照旧走消息渲染，无需迁移。
 */
import { describe, expect, it } from "vitest";
import { initState } from "../../src/tui/state.js";
import { userMessage } from "../../src/core/index.js";
import { formatMailMessage } from "../../src/agent/mailbox.js";
import { AgentPath } from "../../src/agent/agent-path.js";
import type { Message } from "../../src/core/index.js";

const pathOf = (from: string): AgentPath => AgentPath.parse(from) as AgentPath;

const finalAnswer = (from: string, body: string): Message =>
  userMessage(formatMailMessage({ type: "FINAL_ANSWER", from: pathOf(from), content: body, triggerTurn: true }), "system", undefined, undefined, from);

const interrupted = (from: string, body: string): Message =>
  userMessage(formatMailMessage({ type: "INTERRUPTED", from: pathOf(from), content: body, triggerTurn: false }), "system", undefined, undefined, from);

const messageMail = (from: string, body: string): Message =>
  userMessage(formatMailMessage({ type: "MESSAGE", from: pathOf(from), content: body, triggerTurn: false }), "system", undefined, undefined, from);

describe("恢复会话重建 agent 树与活动行", () => {
  it("结论注入重演为完成活动行（带结论正文），树条目为完成态", () => {
    const state = initState([
      userMessage("帮我查一下"),
      finalAnswer("/root/task_1", "查完了，结论如下"),
    ]);
    expect(state.agents).toEqual([
      { path: "/root", status: "running", spawnedAt: null, completedAt: null },
      { path: "/root/task_1", status: "completed", spawnedAt: null, completedAt: null },
    ]);
    const rows = state.blocks.filter((b) => b.kind === "agent");
    expect(rows).toEqual([
      { kind: "agent", event: "completed", path: "/root/task_1", conclusion: "查完了，结论如下", collapsed: true },
    ]);
    // 注入消息不再铺成「你」消息块
    expect(state.blocks.some((b) => b.kind === "message" && b.text.includes("【任务结论】"))).toBe(false);
  });

  it("中断注入重演为中断活动行，树条目为中断态", () => {
    const state = initState([
      userMessage("跑个长任务"),
      interrupted("/root/task_1", "子代理 task_1 已中断，任务未完成。"),
    ]);
    expect(state.agents[1]).toMatchObject({ path: "/root/task_1", status: "interrupted" });
    expect(state.blocks.filter((b) => b.kind === "agent")).toEqual([
      { kind: "agent", event: "interrupted", path: "/root/task_1", collapsed: true },
    ]);
  });

  it("消息注入只建树条目不产生活动行（live 同样不上屏）；同路径先中断后结论终态为完成", () => {
    const state = initState([
      messageMail("/root/task_1", "进度汇报"),
      interrupted("/root/task_1", "已中断"),
      finalAnswer("/root/task_1", "续跑完成"),
    ]);
    expect(state.agents).toHaveLength(2);
    expect(state.agents[1]).toMatchObject({ path: "/root/task_1", status: "completed" });
    const rows = state.blocks.filter((b) => b.kind === "agent");
    expect(rows).toEqual([
      { kind: "agent", event: "interrupted", path: "/root/task_1", collapsed: true },
      { kind: "agent", event: "completed", path: "/root/task_1", conclusion: "续跑完成", collapsed: true },
    ]);
  });

  it("多 agent 各建一条树条目（全路径，同名无歧义）；无 agentPath 的系统消息不受影响", () => {
    const state = initState([
      userMessage("并行跑两个", "human"),
      finalAnswer("/root/task_a", "A 结论"),
      finalAnswer("/root/task_a/sub", "子结论"),
      finalAnswer("/root/task_b", "B 结论"),
      // 无 agentPath 的系统注入（恢复上下文等）照旧走消息渲染
      userMessage("【恢复上下文】历史摘要", "system"),
    ]);
    expect(state.agents.map((a) => a.path)).toEqual(["/root", "/root/task_a", "/root/task_a/sub", "/root/task_b"]);
    expect(
      state.blocks.some((b) => b.kind === "message" && b.source === "system" && b.text.includes("【恢复上下文】")),
    ).toBe(true);
  });

  it("root 自发自收的邮件不建重复树条目、不出活动行，照常按消息渲染", () => {
    const state = initState([
      userMessage("开工", "human"),
      finalAnswer("/root", "自自自言自语"),
    ]);
    expect(state.agents).toEqual([
      { path: "/root", status: "running", spawnedAt: null, completedAt: null },
    ]);
    expect(state.blocks.some((b) => b.kind === "agent")).toBe(false);
    expect(state.blocks.some((b) => b.kind === "message" && b.text.includes("【任务结论】"))).toBe(true);
  });

  it("带 agentPath 但不合邮件格式的消息回落普通消息渲染（不静默丢内容）", () => {
    const state = initState([
      userMessage("注入内容但格式异常", "system", undefined, undefined, "/root/task_1"),
    ]);
    expect(state.agents).toEqual([{ path: "/root", status: "running", spawnedAt: null, completedAt: null }]);
    expect(
      state.blocks.some((b) => b.kind === "message" && b.source === "system" && b.text === "注入内容但格式异常"),
    ).toBe(true);
  });
});
