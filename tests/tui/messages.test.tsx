/**
 * 层 1：消息流渲染——用户/助手/思考折叠/工具卡/子agent/错误/流式 各块的字符帧断言。
 */
import { testRender } from "@opentui/solid";
import { it, expect } from "vitest";
import { Messages } from "../../src/tui/view/Messages.js";
import type { BlockView, Streaming } from "../../src/tui/state.js";

const app = (blocks: BlockView[], streaming?: Streaming) =>
  testRender(() => <Messages blocks={blocks} modelLabel="test-model" streaming={streaming} />, {
    width: 60,
    height: 16,
  });

it("用户消息带头部与文本", async () => {
  const setup = await app([
    { kind: "message", id: "u1", role: "user", text: "重构 partition 逻辑", time: "14:00:01", thinkingCollapsed: true },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("你");
  expect(frame).toContain("重构 partition 逻辑");
});

it("助手消息带思考折叠（收起显示「思考」）", async () => {
  const setup = await app([
    {
      kind: "message",
      id: "a1",
      role: "assistant",
      text: "先看现状实现",
      thinking: "这一步要核对现有分区逻辑…",
      thinkingCollapsed: true,
      time: "14:00:02",
    },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("先看现状实现");
  expect(frame).toContain("思考（▸");
});

it("工具卡按状态显示图标与名称", async () => {
  const ok = await app([
    { kind: "tool", index: 0, turn: 0, name: "read", args: '{"path":"a.ts"}', status: "success", collapsedArgs: true, collapsedOutput: false, output: "export function a() {}" },
  ]);
  await ok.waitForVisualIdle();
  const frame = ok.captureCharFrame();
  expect(frame).toContain("✓");
  expect(frame).toContain("read");
  // 卡片 rounded 框线（视觉分隔体系：边框内标题）
  expect(frame).toContain("╭");

  const fail = await app([
    { kind: "tool", index: 0, turn: 0, name: "grep", args: "{}", status: "failure", error: "Invalid pattern", collapsedArgs: true, collapsedOutput: false },
  ]);
  await fail.waitForVisualIdle();
  expect(fail.captureCharFrame()).toContain("✕");
  expect(fail.captureCharFrame()).toContain("Invalid pattern");
});

it("子 agent 活动行带路径与状态", async () => {
  const setup = await app([
    { kind: "agent", event: "completed", path: "/root/task_1", conclusion: "已合并分区逻辑" },
  ]);
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("子 agent [/root/task_1]");
  expect(setup.captureCharFrame()).toContain("已合并分区逻辑");
});

it("流式尾显示思考与增量文本", async () => {
  const setup = await app([], { text: "正在处理…", thinking: "展开中", isError: false });
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("正在处理");
  expect(frame).toContain("思考（展开中…）");
});

it("错误块标红警示", async () => {
  const setup = await app([
    { kind: "message", id: "e1", role: "assistant", text: "模型响应超时", isError: true, thinkingCollapsed: true },
  ]);
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("模型响应超时");
  expect(setup.captureCharFrame()).toContain("⚠");
});