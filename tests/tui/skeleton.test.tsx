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
import { initState, reduceAction, reduceHook, cyclePermissionMode, cycleThinkingLevel, permissionModeLabel, type TuiState } from "../../src/tui/state.js";

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

it("Shift+Tab 切换权限模式（一般→plan→auto 循环）", () => {
  // opentui tab+shift → shift-tab → mode-cycle（任何 popup 态）
  expect(opentuiKeyToKey({ name: "tab", shift: true })).toEqual({ kind: "shift-tab" });
  expect(mapKey({ kind: "shift-tab" })).toEqual({ type: "mode-cycle" });
  expect(mapKey({ kind: "shift-tab" }, { popup: "modal" as const })).toEqual({ type: "mode-cycle" });
  expect(mapKey({ kind: "shift-tab" }, { popup: "candidate" as const })).toEqual({ type: "mode-cycle" });
  // 纯 cycle：default→plan→bypassPermissions→default
  expect(cyclePermissionMode("default")).toBe("plan");
  expect(cyclePermissionMode("plan")).toBe("bypassPermissions");
  expect(cyclePermissionMode("bypassPermissions")).toBe("default");
  // 显示名（P3 定稿）：default / plan mode / auto mode
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

it("AgentSpawned 追加到 agents 树（main() 恒在首位，去重）", () => {
  const base = initState([]);
  expect(base.agents).toEqual(["/root"]);
  const spawned = reduceHook(base, { type: "AgentSpawned", path: "/root/task_1", parentPath: "/root" });
  expect(spawned.agents).toEqual(["/root", "/root/task_1"]);
  // 重复事件去重
  const dup = reduceHook(spawned, { type: "AgentSpawned", path: "/root/task_1", parentPath: "/root" });
  expect(dup.agents).toEqual(["/root", "/root/task_1"]);
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

it("键盘特殊解析：空格、大写还原、linefeed 回车（opentui 实测行为）", () => {
  expect(opentuiKeyToKey({ name: "space" })).toEqual({ kind: "char", char: " " });
  // opentui 对 A-Z 统一小写 + shift 标志还原大小写
  expect(opentuiKeyToKey({ name: "h", shift: true })).toEqual({ kind: "char", char: "H" });
  expect(opentuiKeyToKey({ name: "linefeed" })).toEqual({ kind: "enter" });
  // Ctrl+Shift+C 是终端复制快捷键，不映射打断
  expect(opentuiKeyToKey({ name: "c", ctrl: true, shift: true })).toEqual({ kind: "ignore" });
});

it("Ctrl+J 换行（主流编辑习惯），映射到软换行 newline", () => {
  // kitty 键盘协议下 ctrl+j 带 ctrl 标志独立到达 → 软换行（非 Enter 发送）
  expect(opentuiKeyToKey({ name: "j", ctrl: true })).toEqual({ kind: "shift-enter" });
  expect(mapKey({ kind: "shift-enter" })).toEqual({ type: "newline" });
  // 普通 j 仍是字符
  expect(opentuiKeyToKey({ name: "j" })).toEqual({ kind: "char", char: "j" });
  // Ctrl+Enter 也走软换行
  expect(opentuiKeyToKey({ name: "return", ctrl: true })).toEqual({ kind: "shift-enter" });
  // 终端忽略 disambiguate、Ctrl+J 按控制字符码点上报（name:"\n"+ctrl）：仍走换行，不落 prompt
  expect(opentuiKeyToKey({ name: "\n", ctrl: true })).toEqual({ kind: "shift-enter" });
  expect(opentuiKeyToKey({ name: "\r", ctrl: true })).toEqual({ kind: "shift-enter" });
  // 裸 "\n"/"\r"（码点无修饰）不再当普通字符插进输入行，按回车语义发送
  expect(opentuiKeyToKey({ name: "\n" })).toEqual({ kind: "enter" });
  expect(opentuiKeyToKey({ name: "\r" })).toEqual({ kind: "enter" });
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