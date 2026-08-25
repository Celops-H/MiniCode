/**
 * 层 1：R1 三区骨架渲染 + 键盘→动作→reducer 纯链路。
 * 视图渲染用 opentui testRender 字符帧断言；键盘链路在有 Solid store 时触发 opentui 全局
 * reconcile（testRender 下 No renderer found），故拆除为纯函数断言：
 * opentuiKeyToKey → mapKey → reduceAction(initState, action)，不经过 channel/store。
 * 真机层 3 验证「按键→视图」闭环。
 */
import { testRender } from "@opentui/solid";
import { it, expect } from "vitest";
import { App } from "../../src/tui/view/App.js";
import { createChannel } from "../../src/tui/loop.js";
import { opentuiKeyToKey } from "../../src/tui/opentuiKeys.js";
import { mapKey } from "../../src/tui/keymap.js";
import { initState, reduceAction } from "../../src/tui/state.js";

function userMessage(text: string) {
  return { role: "user" as const, id: "u1", content: text, source: "human" as const };
}

const app = (channel: ReturnType<typeof createChannel>, model = "test-model", sessionId = "abc123") => (
  <App state={channel.state} model={model} sessionId={sessionId} onAction={channel.onAction} />
);

it("三区骨架渲染历史消息、模型名与空闲状态", async () => {
  const channel = createChannel([userMessage("你好，MiniCode")]);
  const setup = await testRender(() => app(channel), { width: 60, height: 12 });
  await setup.waitForVisualIdle();

  const frame = setup.captureCharFrame();
  expect(frame).toContain("你好，MiniCode");
  expect(frame).toContain("test-model");
  expect(frame).toContain("abc123");
  expect(frame).toContain("● 空闲");
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