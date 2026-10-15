/**
 * 层 1：恢复会话重建多 agent 历史——带 agentPath 的注入消息重演为 agent 活动行
 * （结论/失败/中断）并重建 agent 树条目，不再以「你」消息块铺全文；老数据无 agentPath
 * 字段照旧走消息渲染，无需迁移。
 * 注入消息只覆盖回灌过父的层：未消费的 INTERRUPTED 标记与孙 agent 结论只在轨迹里，
 * 由 AgentOutcome 列表（轨迹补充层）补条目与活动行。
 */
import { describe, expect, it } from "vitest";
import { initState } from "../../src/tui/state.js";
import { userMessage } from "../../src/core/index.js";
import { formatMailMessage } from "../../src/agent/mailbox.js";
import { AgentPath } from "../../src/agent/agent-path.js";
import type { AgentOutcome } from "../../src/observability/index.js";
import type { Message } from "../../src/core/index.js";

const pathOf = (from: string): AgentPath => AgentPath.parse(from) as AgentPath;

const finalAnswer = (from: string, body: string): Message =>
  userMessage(formatMailMessage({ type: "FINAL_ANSWER", from: pathOf(from), content: body, triggerTurn: true }), "system", undefined, undefined, from);

const failedAnswer = (from: string, body: string): Message =>
  userMessage(formatMailMessage({ type: "FAILED", from: pathOf(from), content: body, triggerTurn: true }), "system", undefined, undefined, from);

const interrupted = (from: string, body: string): Message =>
  userMessage(formatMailMessage({ type: "INTERRUPTED", from: pathOf(from), content: body, triggerTurn: false }), "system", undefined, undefined, from);

const messageMail = (from: string, body: string): Message =>
  userMessage(formatMailMessage({ type: "MESSAGE", from: pathOf(from), content: body, triggerTurn: false }), "system", undefined, undefined, from);

const outcome = (
  path: string,
  o: AgentOutcome["outcome"],
  extra: { conclusion?: string; mergeResult?: string } = {},
): AgentOutcome => ({ path, outcome: o, ...extra });

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
      { kind: "agent", event: "completed", path: "/root/task_1", tools: [], conclusion: "查完了，结论如下", collapsed: true },
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
      { kind: "agent", event: "interrupted", path: "/root/task_1", tools: [], collapsed: true },
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
      { kind: "agent", event: "interrupted", path: "/root/task_1", tools: [], collapsed: true },
      { kind: "agent", event: "completed", path: "/root/task_1", tools: [], conclusion: "续跑完成", collapsed: true },
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

  it("失败终态注入重演为失败活动行，树条目为失败态（不再与完成同形）", () => {
    const state = initState([
      userMessage("派活"),
      failedAnswer("/root/task_1", "子代理 task_1 执行失败（模型链耗尽），任务未完成。"),
    ]);
    expect(state.agents[1]).toMatchObject({ path: "/root/task_1", status: "failed" });
    expect(state.blocks.filter((b) => b.kind === "agent")).toEqual([
      {
        kind: "agent",
        event: "failed",
        path: "/root/task_1",
        tools: [],
        conclusion: "子代理 task_1 执行失败（模型链耗尽），任务未完成。",
        collapsed: true,
      },
    ]);
  });

  it("轨迹补充层：注入消息未覆盖的路径补树条目与活动行，已覆盖的路径不重复", () => {
    const state = initState(
      [userMessage("并行跑两个"), finalAnswer("/root/task_a", "A 结论")],
      "",
      "",
      undefined,
      [
        // 已由注入消息重建且终态同态：不重复
        outcome("/root/task_a", "completed", { conclusion: "A 结论" }),
        // 孙 agent 结论只落中间父的子会话文件，主会话注入消息里没有：靠轨迹补
        outcome("/root/task_a/sub", "completed", { conclusion: "孙结论", mergeResult: "已合并" }),
        // 未消费的 INTERRUPTED 标记随收件箱丢弃：靠轨迹补
        outcome("/root/task_b", "interrupted"),
        // 失败终态：按失败活动行重建
        outcome("/root/task_c", "failed", { conclusion: "子代理 task_c 失败：模型链耗尽" }),
        // root 不建重复条目
        outcome("/root", "completed", { conclusion: "自收" }),
      ],
    );
    expect(state.agents.map((a) => a.path)).toEqual([
      "/root",
      "/root/task_a",
      "/root/task_a/sub",
      "/root/task_b",
      "/root/task_c",
    ]);
    expect(state.agents.map((a) => a.status)).toEqual([
      "running",
      "completed",
      "completed",
      "interrupted",
      "failed",
    ]);
    expect(state.blocks.filter((b) => b.kind === "agent")).toEqual([
      { kind: "agent", event: "completed", path: "/root/task_a", tools: [], conclusion: "A 结论", collapsed: true },
      {
        kind: "agent",
        event: "completed",
        path: "/root/task_a/sub",
        tools: [],
        conclusion: "孙结论",
        mergeResult: "已合并",
        collapsed: true,
      },
      { kind: "agent", event: "interrupted", path: "/root/task_b", tools: [], collapsed: true },
      {
        kind: "agent",
        event: "failed",
        path: "/root/task_c",
        tools: [],
        conclusion: "子代理 task_c 失败：模型链耗尽",
        collapsed: true,
      },
    ]);
  });

  it("轨迹补充层：终态邮件之后又有新终态的路径按轨迹补新段（旧终态行保留）", () => {
    // 先完成（结论已回灌并落盘），followup 唤醒后再跑以失败告终，失败邮件未消费：
    // 注入消息只留完成一条，最后终态在轨迹里
    const state = initState(
      [userMessage("派活"), finalAnswer("/root/task_1", "第一次完成")],
      "",
      "",
      undefined,
      [outcome("/root/task_1", "failed", { conclusion: "子代理 task_1 失败：模型链耗尽" })],
    );
    expect(state.agents).toEqual([
      { path: "/root", status: "running", spawnedAt: null, completedAt: null },
      { path: "/root/task_1", status: "failed", spawnedAt: null, completedAt: null },
    ]);
    expect(state.blocks.filter((b) => b.kind === "agent")).toEqual([
      {
        kind: "agent",
        event: "completed",
        path: "/root/task_1",
        tools: [],
        conclusion: "第一次完成",
        collapsed: true,
      },
      {
        kind: "agent",
        event: "failed",
        path: "/root/task_1",
        tools: [],
        conclusion: "子代理 task_1 失败：模型链耗尽",
        collapsed: true,
      },
    ]);
  });

  it("轨迹补充层：完成但空结论保留空串（视图据此出「未产出结论」警示）", () => {
    const state = initState([], "", "", undefined, [outcome("/root/task_1", "completed", { conclusion: "" })]);
    expect(state.blocks.filter((b) => b.kind === "agent")).toEqual([
      { kind: "agent", event: "completed", path: "/root/task_1", tools: [], conclusion: "", collapsed: true },
    ]);
  });
});
