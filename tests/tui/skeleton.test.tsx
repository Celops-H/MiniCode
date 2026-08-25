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
import { initState, reduceAction } from "../../src/tui/state.js";

it("fold-at：鼠标点折叠头直接翻该块（不带聚焦）", () => {
  // 塞一个带思考的助手块（可折叠）+ 一个不可折叠块
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