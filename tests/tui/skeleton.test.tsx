/**
 * 层 1：键盘→动作→reducer 纯链路 + channel（store 通道）直测。
 * 视图渲染断言在 tests/tui/render.test.tsx（App）与 messages.test.tsx（Messages 组件）。
 * 本文件不含 testRender：避免 opentui 渲染器残留污染 store/reducer 纯断言（同文件混合时
 * Solid 全局 reconcile 会报 No renderer found）。
 */
import { it, expect } from "vitest";
import { createChannel } from "../../src/tui/loop.js";
import { opentuiKeyToKey } from "../../src/tui/opentuiKeys.js";
import { mapKey } from "../../src/tui/keymap.js";
import {
  initState,
  reduceAction,
  reduceHook,
  cyclePermissionMode,
  cycleThinkingLevel,
  permissionModeLabel,
  hasRunningAgent,
  agentsInFlight,
  isFoldable,
  formatTime,
  type TuiState,
  type MessageBlock,
} from "../../src/tui/state.js";
import type { Message } from "../../src/core/index.js";

/** 取块序列里的子 agent 活动块（断言用，收窄类型） */
const agentSegments = (s: TuiState): Array<Extract<TuiState["blocks"][number], { kind: "agent" }>> =>
  s.blocks.filter((b): b is Extract<TuiState["blocks"][number], { kind: "agent" }> => b.kind === "agent");

it("fold-at：鼠标点折叠头直接翻该块（不带聚焦）", () => {
  const base = initState([]);
  const withBlocks = {
    ...base,
    blocks: [
      { kind: "message", id: "a1", role: "assistant", text: "结论", thinking: "很长的一段思考内容用于折叠判定", thinkingCollapsed: true },
      { kind: "message", id: "u1", role: "user", text: "继续", thinkingCollapsed: true },
    ] as typeof base.blocks,
  };
  // 展开 index 0（有思考）折叠
  const unfolded = reduceAction(withBlocks, { type: "fold-at", index: 0 });
  expect(unfolded.blocks[0]?.kind === "message" && unfolded.blocks[0].thinkingCollapsed).toBe(false);
  // index 1 不可折叠（无 thinking）：原样
  const unchanged = reduceAction(withBlocks, { type: "fold-at", index: 1 });
  expect(unchanged.blocks[1]).toBe(withBlocks.blocks[1]);
});

it("fold-at 翻子 agent 段折叠态（有结论或工具行才可折叠；刚派生无内容不可翻）", () => {
  const base = initState([]);
  const withAgent = {
    ...base,
    blocks: [
      { kind: "agent", event: "completed", path: "/root/t", tools: [], conclusion: "ok", collapsed: true },
    ] as typeof base.blocks,
  };
  // completed 有结论 → 折叠翻转 true→false
  const unfolded = reduceAction(withAgent, { type: "fold-at", index: 0 });
  expect(unfolded.blocks[0]?.kind === "agent" && unfolded.blocks[0].collapsed).toBe(false);
  // 刚派生（无工具无结论）→ 不可折叠，原样保留
  const spawned = {
    ...base,
    blocks: [{ kind: "agent", event: "running", path: "/root/t", tools: [], collapsed: true }] as typeof base.blocks,
  };
  const unchanged = reduceAction(spawned, { type: "fold-at", index: 0 });
  expect(unchanged.blocks[0]).toBe(spawned.blocks[0]);
});

it("connect key 弹窗输入态：字符进 key 缓冲、不弹 slash 候选（弹窗内是输 API Key）", () => {
  const base: TuiState = {
    ...initState([]),
    modal: {
      kind: "connect-key",
      providerId: "deepseek",
      providerName: "DeepSeek",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      defaultModel: "deepseek-chat",
      key: "",
    },
  };
  const s = reduceAction(base, { type: "input", text: "/" });
  // 弹窗内输 / 计入 key 缓冲，不应算成命令候选
  expect(s.modal).toMatchObject({ kind: "connect-key", key: "/" });
  expect(s.candidate).toBeUndefined();
});

it("Shift+Tab 切换权限模式（default→plan→bypassPermissions 循环 + 显示名映射）", () => {
  // opentui tab+shift → shift-tab → mode-cycle（任何 popup 态）
  expect(opentuiKeyToKey({ name: "tab", shift: true })).toEqual({ kind: "shift-tab" });
  expect(mapKey({ kind: "shift-tab" })).toEqual({ type: "mode-cycle" });
  expect(mapKey({ kind: "shift-tab" }, { popup: "modal" as const })).toEqual({ type: "mode-cycle" });
  expect(mapKey({ kind: "shift-tab" }, { popup: "candidate" as const })).toEqual({ type: "mode-cycle" });
  // 纯 cycle：default→plan→bypassPermissions→default
  expect(cyclePermissionMode("default")).toBe("plan");
  expect(cyclePermissionMode("plan")).toBe("bypassPermissions");
  expect(cyclePermissionMode("bypassPermissions")).toBe("default");
  // 显示名：default / plan mode / auto mode
  expect(permissionModeLabel("default")).toBe("default");
  expect(permissionModeLabel("plan")).toBe("plan mode");
  expect(permissionModeLabel("bypassPermissions")).toBe("auto mode");
});

it("cycleThinkingLevel：默认→low→medium→high→默认", () => {
  expect(cycleThinkingLevel(undefined)).toBe("low");
  expect(cycleThinkingLevel("low")).toBe("medium");
  expect(cycleThinkingLevel("medium")).toBe("high");
  expect(cycleThinkingLevel("high")).toBe(undefined);
});

it("AgentSpawned 追加到 agents 树（main 恒在首位，去重；完成带时刻）", () => {
  const base = initState([]);
  expect(base.agents).toEqual([{ path: "/root", status: "running", spawnedAt: null, completedAt: null }]);
  const spawned = reduceHook(base, { type: "AgentSpawned", path: "/root/task_1", parentPath: "/root" });
  expect(spawned.agents).toEqual([
    { path: "/root", status: "running", spawnedAt: null, completedAt: null },
    { path: "/root/task_1", status: "running", spawnedAt: null, completedAt: null },
  ]);
  // 重复事件去重（活动块同口径：该路径仍在途，不重开段，防止先驱段永远停在「运行中」）
  const dup = reduceHook(spawned, { type: "AgentSpawned", path: "/root/task_1", parentPath: "/root" });
  expect(dup.agents).toHaveLength(2);
  expect(agentSegments(dup)).toHaveLength(1);
  // 完成事件：状态改 completed + 记录完成时刻（loop 注入），派生时刻保留算耗时
  const done = reduceHook(dup, { type: "AgentCompleted", path: "/root/task_1", parentPath: "/root", conclusion: "ok", completedAt: 1000 });
  expect(done.agents[1]).toEqual({ path: "/root/task_1", status: "completed", spawnedAt: null, completedAt: 1000 });
  // 中断事件：状态改 interrupted + 记录完成时刻（同样 10s 后从树消失）
  const aborted = reduceHook(done, { type: "AgentInterrupted", path: "/root/task_1", parentPath: "/root", completedAt: 2000 });
  expect(aborted.agents[1]).toEqual({ path: "/root/task_1", status: "interrupted", spawnedAt: null, completedAt: 2000 });
});

it("AgentSpawned 唤醒已完成 agent：条目重置为运行态（树重新亮起）", () => {
  const base = initState([]);
  const spawned = reduceHook(base, { type: "AgentSpawned", path: "/root/t", parentPath: "/root", spawnedAt: 100 });
  const done = reduceHook(spawned, {
    type: "AgentCompleted",
    path: "/root/t",
    parentPath: "/root",
    conclusion: "ok",
    completedAt: 200,
  });
  expect(done.agents[1]).toMatchObject({ status: "completed" });
  // followup 唤醒：再发 AgentSpawned → 条目回运行态、完成时刻清空，spawnedAt 保留
  const revived = reduceHook(done, { type: "AgentSpawned", path: "/root/t", parentPath: "/root" });
  expect(revived.agents[1]).toEqual({ path: "/root/t", status: "running", spawnedAt: 100, completedAt: null });
});

it("AgentCompleted.failed：树条目落失败态、活动行标失败（不再与完成同形）", () => {
  const base = initState([]);
  const spawned = reduceHook(base, { type: "AgentSpawned", path: "/root/t", parentPath: "/root", spawnedAt: 100 });
  const failed = reduceHook(spawned, {
    type: "AgentCompleted",
    path: "/root/t",
    parentPath: "/root",
    conclusion: "子代理 t 失败：连接超时",
    failed: true,
    completedAt: 900,
  });
  expect(failed.agents[1]).toEqual({ path: "/root/t", status: "failed", spawnedAt: 100, completedAt: 900 });
  expect(failed.blocks.at(-1)).toMatchObject({ kind: "agent", event: "failed", path: "/root/t", collapsed: true });
  // 失败结论可展开看全文（与完成的结论走同一条折叠链）
  expect(isFoldable(failed.blocks.at(-1)!)).toBe(true);
  // 失败但没有结论/合并结果与工具行（正常路径不会出现）：不可折叠，不挂出无内容的折叠提示
  expect(isFoldable({ kind: "agent", event: "failed", path: "/root/t", tools: [], collapsed: true })).toBe(false);
  // 失败不算运行中：Esc 判定与重装配守卫按终态放行
  expect(hasRunningAgent(failed.agents)).toBe(false);
  // followup 唤醒失败条目：与完成态一样重置回运行态
  expect(reduceHook(failed, { type: "AgentSpawned", path: "/root/t", parentPath: "/root" }).agents[1]).toEqual({
    path: "/root/t",
    status: "running",
    spawnedAt: 100,
    completedAt: null,
  });
  // 无 failed 标记的完成事件仍是 completed（失败态不误伤正常完成）
  const done = reduceHook(spawned, { type: "AgentCompleted", path: "/root/t", parentPath: "/root", conclusion: "ok", completedAt: 900 });
  expect(done.agents[1]).toMatchObject({ status: "completed" });
  expect(done.blocks.at(-1)).toMatchObject({ event: "completed" });
});

it("子 agent 工具事件收进活动块：不铺主消息流工具卡，完成收束同一段", () => {
  let s = reduceHook(initState([]), { type: "AgentSpawned", path: "/root/task_1", parentPath: "/root", spawnedAt: 100 });
  // 派生开段：运行中块、无工具行
  expect(s.blocks).toEqual([
    { kind: "agent", event: "running", path: "/root/task_1", tools: [], collapsed: true },
  ]);
  // 子 agent 工具调用：不进主消息流工具卡，挂进段内工具行
  s = reduceHook(s, { type: "PreToolUse", toolCallId: "c1", toolName: "read", input: { path: "a.ts" }, agentPath: "/root/task_1" });
  expect(s.blocks.some((b) => b.kind === "tool")).toBe(false);
  expect(agentSegments(s)[0]!.tools).toEqual([
    { id: "c1", name: "read", args: '{"path":"a.ts"}', status: "running" },
  ]);
  // 主 agent 同步工具事件仍铺主工具卡（分流不误伤 root）
  s = reduceHook(s, { type: "PreToolUse", toolCallId: "r1", toolName: "bash", input: { command: "ls" }, agentPath: "/root" });
  expect(s.blocks.some((b) => b.kind === "tool" && b.id === "r1")).toBe(true);
  // 结果事件写回段内工具行：成功 + 耗时
  s = reduceHook(s, {
    type: "PostToolUse",
    toolCallId: "c1",
    toolName: "read",
    input: { path: "a.ts" },
    output: "ok",
    isError: false,
    durationMs: 120,
    agentPath: "/root/task_1",
  });
  expect(agentSegments(s)[0]!.tools).toEqual([
    { id: "c1", name: "read", args: '{"path":"a.ts"}', status: "success", durationMs: 120 },
  ]);
  // 完成收束同一段：段数不变，event 转 completed，工具行保留并挂上结论
  s = reduceHook(s, { type: "AgentCompleted", path: "/root/task_1", parentPath: "/root", conclusion: "结论一", completedAt: 900 });
  const segments = agentSegments(s);
  expect(segments).toHaveLength(1);
  expect(segments[0]).toMatchObject({ event: "completed", conclusion: "结论一" });
  expect(segments[0]!.tools).toHaveLength(1);
});

it("子 agent 失败与中断收束段：工具行保留，段头转对应终态", () => {
  const spawn = (): TuiState => reduceHook(initState([]), { type: "AgentSpawned", path: "/root/t", parentPath: "/root" });
  // 执行中失败（PostToolUseFailure 带原因）→ 段内工具行落失败态
  let s = spawn();
  s = reduceHook(s, {
    type: "PostToolUseFailure",
    toolCallId: "c1",
    toolName: "bash",
    input: { command: "x" },
    error: "命令失败：退出码 1",
    durationMs: 40,
    agentPath: "/root/t",
  });
  expect(agentSegments(s)[0]!.tools).toEqual([
    { id: "c1", name: "bash", args: '{"command":"x"}', status: "failure", error: "命令失败：退出码 1", durationMs: 40 },
  ]);
  // 失败标记完成的调用（执行器先发 PostToolUseFailure 后发 PostToolUse）：错误取完整输出，
  // 后到事件不带 durationMs 时保留原耗时
  s = reduceHook(s, {
    type: "PostToolUse",
    toolCallId: "c1",
    toolName: "bash",
    input: { command: "x" },
    output: "命令失败：退出码 1\n部分输出",
    isError: true,
    agentPath: "/root/t",
  });
  expect(agentSegments(s)[0]!.tools).toEqual([
    {
      id: "c1",
      name: "bash",
      args: '{"command":"x"}',
      status: "failure",
      error: "命令失败：退出码 1\n部分输出",
      durationMs: 40,
    },
  ]);
  // 中断收束：同一段转中断，工具行原样保留
  s = reduceHook(s, { type: "AgentInterrupted", path: "/root/t", parentPath: "/root", completedAt: 800 });
  expect(agentSegments(s)).toHaveLength(1);
  expect(agentSegments(s)[0]).toMatchObject({ event: "interrupted" });
  expect(agentSegments(s)[0]!.tools).toHaveLength(1);
  // 失败终态：failed 标记的 AgentCompleted 收束为 failed
  let f = spawn();
  f = reduceHook(f, { type: "AgentCompleted", path: "/root/t", parentPath: "/root", conclusion: "子代理 t 失败：连接超时", failed: true, completedAt: 900 });
  expect(agentSegments(f)[0]).toMatchObject({ event: "failed" });
});

it("followup 唤醒开新段：同名路径两段互不串（先完成段的结论与工具行不动）", () => {
  let s = reduceHook(initState([]), { type: "AgentSpawned", path: "/root/t", parentPath: "/root" });
  s = reduceHook(s, { type: "PreToolUse", toolCallId: "c1", toolName: "read", input: {}, agentPath: "/root/t" });
  s = reduceHook(s, { type: "AgentCompleted", path: "/root/t", parentPath: "/root", conclusion: "第一段结论" });
  // 唤醒：新段（运行中、无工具），已完成段保留
  s = reduceHook(s, { type: "AgentSpawned", path: "/root/t", parentPath: "/root" });
  expect(agentSegments(s)).toHaveLength(2);
  expect(agentSegments(s)[1]).toMatchObject({ event: "running", tools: [] });
  // 新段的工具事件落新段：第一段不变
  s = reduceHook(s, { type: "PreToolUse", toolCallId: "c2", toolName: "grep", input: {}, agentPath: "/root/t" });
  expect(agentSegments(s)[0]).toMatchObject({ event: "completed", conclusion: "第一段结论" });
  expect(agentSegments(s)[0]!.tools).toHaveLength(1);
  expect(agentSegments(s)[1]!.tools).toHaveLength(1);
  // 第一段的迟到结果事件按调用 id 归位原段（两段并存时不被误并入新段）
  s = reduceHook(s, {
    type: "PostToolUse",
    toolCallId: "c1",
    toolName: "read",
    input: {},
    output: "ok",
    isError: false,
    durationMs: 5,
    agentPath: "/root/t",
  });
  expect(agentSegments(s)[0]!.tools).toEqual([{ id: "c1", name: "read", args: "{}", status: "success", durationMs: 5 }]);
  expect(agentSegments(s)[1]!.tools).toEqual([{ id: "c2", name: "grep", args: "{}", status: "running" }]);
  // 同 id 新调用（无 id 厂商合成 call_N 跨轮复用）并入新段：PreToolUse 不跨段按 id 归位
  s = reduceHook(s, { type: "PreToolUse", toolCallId: "c1", toolName: "bash", input: {}, agentPath: "/root/t" });
  expect(agentSegments(s)[0]!.tools).toEqual([{ id: "c1", name: "read", args: "{}", status: "success", durationMs: 5 }]);
  expect(agentSegments(s)[1]!.tools).toEqual([
    { id: "c2", name: "grep", args: "{}", status: "running" },
    { id: "c1", name: "bash", args: "{}", status: "running" },
  ]);
});

it("子 agent 工具事件不置根回合运行态（status 是根回合口径，后台子 agent 活跃不代偿）", () => {
  let s = reduceHook(initState([]), { type: "AgentSpawned", path: "/root/t", parentPath: "/root" });
  expect(s.status).toBe("idle");
  s = reduceHook(s, { type: "PreToolUse", toolCallId: "c1", toolName: "read", input: {}, agentPath: "/root/t" });
  expect(s.status).toBe("idle");
  s = reduceHook(s, { type: "PostToolUse", toolCallId: "c1", toolName: "read", input: {}, output: "ok", isError: false, agentPath: "/root/t" });
  // 状态行不因后台子 agent 的工具事件置运行态：子 agent 的 Stop 不回落它，置位会让状态行停在运行中
  expect(s.status).toBe("idle");
  expect(hasRunningAgent(s.agents)).toBe(true); // 活跃判定由 agent 树承担
});

it("工具事件无运行中段：并入最近段不新开（防悬空），无段时才补开承接段", () => {
  // 收束后到的工具事件（事件序异常/丢终态）：并入已完成段，不新开运行段
  let s = reduceHook(initState([]), { type: "AgentSpawned", path: "/root/t", parentPath: "/root" });
  s = reduceHook(s, { type: "AgentCompleted", path: "/root/t", parentPath: "/root", conclusion: "ok" });
  s = reduceHook(s, { type: "PostToolUseFailure", toolCallId: "late", toolName: "bash", input: {}, error: "余波", agentPath: "/root/t" });
  expect(agentSegments(s)).toHaveLength(1);
  expect(agentSegments(s)[0]).toMatchObject({ event: "completed" });
  expect(agentSegments(s)[0]!.tools).toHaveLength(1);
  // 该路径一个段都没有（派生事件缺失）：补开运行段承接，仍不落主消息流工具卡
  let d = reduceHook(initState([]), { type: "PreToolUse", toolCallId: "c9", toolName: "read", input: {}, agentPath: "/root/gone" });
  expect(d.blocks.some((b) => b.kind === "tool")).toBe(false);
  expect(agentSegments(d)).toHaveLength(1);
  expect(agentSegments(d)[0]).toMatchObject({ event: "running", path: "/root/gone" });
});

it("hasRunningAgent：主 agent 或 completed/interrupted 不算，运行中的子 agent 才算", () => {
  expect(hasRunningAgent(initState([]).agents)).toBe(false);
  const withSub = (status: "running" | "completed" | "interrupted"): TuiState["agents"] => [
    { path: "/root", status: "running", spawnedAt: null, completedAt: null },
    { path: "/root/t", status, spawnedAt: 1, completedAt: status === "running" ? null : 2 },
  ];
  expect(hasRunningAgent(withSub("running"))).toBe(true);
  expect(hasRunningAgent(withSub("completed"))).toBe(false);
  expect(hasRunningAgent(withSub("interrupted"))).toBe(false);
});

it("Stop：子 agent 的 Stop 不把主界面打成空闲；主 agent（/root）的才回空闲", () => {
  const base: TuiState = { ...initState([]), status: "running" };
  const subStop = reduceHook(base, { type: "Stop", agentPath: "/root/t" });
  expect(subStop.status).toBe("running"); // 子 agent 每轮结束不打断主回合
  const rootStop = reduceHook(subStop, { type: "Stop", agentPath: "/root" });
  expect(rootStop.status).toBe("idle");
});

it("Esc 判定组合：主状态空闲 + 子 agent 运行中 → loop 并入 agentsInFlight 判打断", () => {
  // 复刻 loop esc 分支的组合：running 并入 agent 树运行态
  const withSubRunning: TuiState = {
    ...initState([]),
    agents: [
      { path: "/root", status: "running", spawnedAt: null, completedAt: null },
      { path: "/root/t", status: "running", spawnedAt: 1, completedAt: null },
    ],
  };
  expect(agentsInFlight(withSubRunning)).toBe(true);
  // 子 agent 全部完成/中断：不再判打断（空闲双击退出逻辑恢复）
  const allDone: TuiState = {
    ...initState([]),
    agents: [
      { path: "/root", status: "running", spawnedAt: null, completedAt: null },
      { path: "/root/t", status: "completed", spawnedAt: 1, completedAt: 2 },
    ],
  };
  expect(agentsInFlight(allDone)).toBe(false);
});

it("initState 恢复历史消息：user/assistant 带创建时间戳（reconfigure 后时间不丢）", () => {
  const messages: Message[] = [
    { role: "user", id: "u1", content: "你好", timestamp: "2026-08-27T03:04:05.000Z" },
    {
      role: "assistant",
      id: "a1",
      content: [{ type: "text", text: "回复" }],
      timestamp: "2026-08-27T03:04:06.000Z",
    },
    { role: "user", id: "u2", content: "无时间戳旧数据" },
  ];
  const state = initState(messages);
  const msgs = state.blocks.filter((b) => b.kind === "message") as MessageBlock[];
  expect(msgs[0]?.time).toBe(formatTime(new Date("2026-08-27T03:04:05.000Z")));
  expect(msgs[1]?.time).toBe(formatTime(new Date("2026-08-27T03:04:06.000Z")));
  // 旧数据缺 timestamp：不显示时间，不回退乱值
  expect(msgs[2]?.time).toBeUndefined();
});

it("initState：非法时间戳不显示（防 NaN:NaN:NaN）", () => {
  const messages: Message[] = [
    { role: "user", id: "u1", content: "坏时间", timestamp: "garbage" },
    { role: "assistant", id: "a1", content: [{ type: "text", text: "回复" }], timestamp: "not-a-date" },
  ];
  const state = initState(messages);
  const msgs = state.blocks.filter((b) => b.kind === "message") as MessageBlock[];
  expect(msgs[0]?.time).toBeUndefined(); // 非法字符串 → Invalid Date → 不显示
  expect(msgs[1]?.time).toBeUndefined();
});

it("键盘字符：opentui 键→mapKey→输入插件 reducer", () => {
  const key = opentuiKeyToKey({ name: "h", ctrl: false, shift: false });
  expect(key).toEqual({ kind: "char", char: "h" });
  const action = mapKey(key, { inputEmpty: true });
  expect(action).toEqual({ type: "input", text: "h" });
  const state = reduceAction(initState([]), action);
  expect(state.prompt.lines[0]).toBe("h");
  expect(state.prompt.curCol).toBe(1);
});

it("键盘特殊解析：空格、大写还原、linefeed 软换行（opentui 实测行为）", () => {
  expect(opentuiKeyToKey({ name: "space" })).toEqual({ kind: "char", char: " " });
  // opentui 对 A-Z 统一小写 + shift 标志还原大小写
  expect(opentuiKeyToKey({ name: "h", shift: true })).toEqual({ kind: "char", char: "H" });
  // LF 键名 linefeed = Ctrl+J（无 kitty 协议时 opentui 把 0x0A 解析为此）→ 软换行，不发送
  expect(opentuiKeyToKey({ name: "linefeed" })).toEqual({ kind: "shift-enter" });
  // Ctrl+Shift+C 是终端复制快捷键，不映射打断
  expect(opentuiKeyToKey({ name: "c", ctrl: true, shift: true })).toEqual({ kind: "ignore" });
});

it("Ctrl+S：/model 弹窗设默认模型的键到达（kitty 协议上报），无 ctrl 时按普通字符", () => {
  // 带 shift 的 ctrl 组合同 ctrl-p 口径：统一归 ctrl-s（opentui 对字母统一小写上报）
  expect(opentuiKeyToKey({ name: "s", ctrl: true, shift: true })).toEqual({ kind: "ctrl-s" });
  expect(opentuiKeyToKey({ name: "s", ctrl: true })).toEqual({ kind: "ctrl-s" });
  expect(opentuiKeyToKey({ name: "s" })).toEqual({ kind: "char", char: "s" });
  expect(opentuiKeyToKey({ name: "s", shift: true })).toEqual({ kind: "char", char: "S" });
});

it("Ctrl+J 换行（主流编辑习惯），映射到软换行 newline", () => {
  // kitty 键盘协议下 ctrl+j 带 ctrl 标志独立到达 → 软换行（非 Enter 发送）
  expect(opentuiKeyToKey({ name: "j", ctrl: true })).toEqual({ kind: "shift-enter" });
  expect(mapKey({ kind: "shift-enter" })).toEqual({ type: "newline" });
  // 普通 j 仍是字符
  expect(opentuiKeyToKey({ name: "j" })).toEqual({ kind: "char", char: "j" });
  // Ctrl+Enter 也走软换行
  expect(opentuiKeyToKey({ name: "return", ctrl: true })).toEqual({ kind: "shift-enter" });
  // 终端忽略 disambiguate、Ctrl+J 按控制字符码点上报：带 ctrl 或裸 LF 都走软换行
  expect(opentuiKeyToKey({ name: "\n", ctrl: true })).toEqual({ kind: "shift-enter" });
  expect(opentuiKeyToKey({ name: "\r", ctrl: true })).toEqual({ kind: "shift-enter" });
  // 裸 LF（\n，Ctrl+J 的码点）→ 软换行；裸 CR（\r，Enter 键的码点）→ 回车发送
  expect(opentuiKeyToKey({ name: "\n" })).toEqual({ kind: "shift-enter" });
  expect(opentuiKeyToKey({ name: "\r" })).toEqual({ kind: "enter" });
  // 无 kitty 协议时 opentui 把 LF 解析为 name:"linefeed"（无 ctrl）→ 也软换行（此前误按发送，真机复现过）
  expect(opentuiKeyToKey({ name: "linefeed" })).toEqual({ kind: "shift-enter" });
});

it("输入编辑键 Ctrl+A/E/U/K/W 从 opentui 键映射到结构键（普通字母不受影响）", () => {
  expect(opentuiKeyToKey({ name: "a", ctrl: true })).toEqual({ kind: "ctrl-a" });
  expect(opentuiKeyToKey({ name: "e", ctrl: true })).toEqual({ kind: "ctrl-e" });
  expect(opentuiKeyToKey({ name: "u", ctrl: true })).toEqual({ kind: "ctrl-u" });
  expect(opentuiKeyToKey({ name: "k", ctrl: true })).toEqual({ kind: "ctrl-k" });
  expect(opentuiKeyToKey({ name: "w", ctrl: true })).toEqual({ kind: "ctrl-w" });
  expect(opentuiKeyToKey({ name: "a" })).toEqual({ kind: "char", char: "a" });
  // Shift+编辑键字母：大写还原不受影响（opentui 对 A-Z 统一小写 + shift 标志）
  expect(opentuiKeyToKey({ name: "a", shift: true })).toEqual({ kind: "char", char: "A" });
  expect(opentuiKeyToKey({ name: "e", shift: true })).toEqual({ kind: "char", char: "E" });
  expect(opentuiKeyToKey({ name: "j", shift: true })).toEqual({ kind: "char", char: "J" });
});

it("输入编辑键落地 reducer：Ctrl+A/E 行首尾、U 清行、K 删到行尾、W 删前词", () => {
  const typed = reduceAction(reduceAction(initState([]), { type: "input", text: "hello world" }), { type: "input", text: "!" });
  let s = reduceAction(typed, { type: "cursor", dir: "start" });
  expect(s.prompt.curCol).toBe(0);
  s = reduceAction(s, { type: "cursor", dir: "end" });
  expect(s.prompt.curCol).toBe(12);
  // Ctrl+W 删前词：光标在 "hello world!" 末尾 → 删 "world!" 词（词前空格保留）→ "hello "
  s = reduceAction(s, { type: "delete-word" });
  expect(s.prompt.lines[0]).toBe("hello ");
  // Ctrl+U 清整行
  s = reduceAction(s, { type: "delete-line" });
  expect(s.prompt.lines[0]).toBe("");
  // Ctrl+K 删到行尾：光标放 "ab|cdef" 的 c 后
  s = reduceAction(s, { type: "input", text: "abcdef" });
  s = reduceAction(s, { type: "cursor", dir: "start" });
  s = reduceAction(s, { type: "cursor", dir: "right" });
  s = reduceAction(s, { type: "cursor", dir: "right" });
  s = reduceAction(s, { type: "delete-to-end" });
  expect(s.prompt.lines[0]).toBe("ab");
  // 边界：空行删词不动、行首删词不动、全空格行删词清空、连续空格删词只删词
  s = reduceAction(initState([]), { type: "delete-word" });
  expect(s.prompt.lines[0]).toBe("");
  let sp = reduceAction(initState([]), { type: "input", text: "word" });
  sp = reduceAction(sp, { type: "cursor", dir: "start" });
  sp = reduceAction(sp, { type: "delete-word" });
  expect(sp.prompt.lines[0]).toBe("word");
  sp = reduceAction(initState([]), { type: "input", text: "   " });
  sp = reduceAction(sp, { type: "delete-word" });
  expect(sp.prompt.lines[0]).toBe("");
  sp = reduceAction(initState([]), { type: "input", text: "aa  bb" });
  sp = reduceAction(sp, { type: "cursor", dir: "end" });
  sp = reduceAction(sp, { type: "delete-word" });
  expect(sp.prompt.lines[0]).toBe("aa  ");
});

it("channel.onAction 走 store 整树替换（不依赖渲染）", () => {
  const channel = createChannel([]);
  channel.onAction({ type: "input", text: "hi" });
  expect(channel.state.prompt.lines[0]).toBe("hi");
  channel.onAction({ type: "backspace" });
  channel.onAction({ type: "backspace" });
  expect(channel.state.prompt.lines[0]).toBe("");
});

it("回车 send：清空输入、记历史、进入运行态（真实发送待 R1b 接 interact）", () => {
  const action = mapKey(opentuiKeyToKey({ name: "return", ctrl: false, shift: false }), { inputEmpty: false });
  expect(action).toEqual({ type: "send" });
  let state = initState([]);
  for (const ch of "go") state = reduceAction(state, { type: "input", text: ch });
  state = reduceAction(state, action);
  expect(state.status).toBe("running");
  expect(state.prompt.lines).toEqual([""]);
  expect(state.prompt.history).toContain("go");
});

it("发送后输入框清空（channel 走 reconcile：空 prompt 必须换新数组，曾共享引用跳过更新）", () => {
  const channel = createChannel([]);
  channel.onAction({ type: "input", text: "hi" });
  expect(channel.state.prompt.lines).toEqual(["hi"]);
  channel.onAction({ type: "send" });
  // 清空到首行首列、文本为空、历史记入
  expect(channel.state.prompt.lines).toEqual([""]);
  expect(channel.state.prompt.curLine).toBe(0);
  expect(channel.state.prompt.curCol).toBe(0);
  expect(channel.state.status).toBe("running");
  expect(channel.state.prompt.history).toContain("hi");
});