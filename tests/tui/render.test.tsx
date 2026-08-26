/**
 * 层 1：视图渲染冒烟——opentui 渲染链就位，根组件渲染预期内容。
 * 断言用 opentui testRender 的字符帧（captureCharFrame），替代旧「帧行数组」断言方式。
 * 注意：状态行用窄宽用例钉住「窄屏不折行」——flexShrink:0 使右侧溢出被截而非换行。
 */
import { testRender } from "@opentui/solid";
import { createStore } from "solid-js/store";
import { describe, it, expect } from "vitest";
import { App } from "../../src/tui/view/App.js";
import { createChannel } from "../../src/tui/loop.js";
import { initState, reduceHook, type TuiState } from "../../src/tui/state.js";

/** 取首个文本等于 text 的 span 的 fg 颜色（hex）；无匹配或无颜色返回 undefined */
function textFg(frame: { lines: Array<{ spans: Array<{ text: string; fg?: unknown }> }> }, text: string): string | undefined {
  for (const line of frame.lines) {
    for (const span of line.spans) {
      if (span.text === text) {
        const buf = (span.fg as { buffer?: ArrayLike<number> } | undefined)?.buffer;
        if (!buf) return undefined;
        return `#${[0, 1, 2].map((i) => (buf[i] ?? 0).toString(16).padStart(2, "0")).join("")}`;
      }
    }
  }
  return undefined;
}

describe("view/App 渲染链", () => {
  it("根组件渲染出界面骨架内容", async () => {
    const channel = createChannel([]);
    const setup = await testRender(
      () => (
        <App state={channel.state} model="test-model" sessionId="abc123" onAction={channel.onAction} />
      ),
      { width: 64, height: 8 },
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("test-model");
    expect(frame).toContain("● 空闲");
  });

  it("窄屏（44 列）：状态行不折行、模型名与模式保留", async () => {
    const channel = createChannel([]);
    const setup = await testRender(
      () => (
        <App state={channel.state} model="test-model" sessionId="abc123" onAction={channel.onAction} />
      ),
      { width: 44, height: 8 },
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    // 模型名与权限模式 chip 保留在同一行（flexShrink:0 右侧溢出被截而非换行）
    expect(frame).toContain("test-model");
    expect(frame).toContain("模式[default]");
  });

  it("状态栏当前模型名蓝色（与圆点同色 modelColor，用户复核：模型名应为蓝）", async () => {
    const channel = createChannel([]);
    const setup = await testRender(
      () => (
        <App state={channel.state} model="model-blue" sessionId="abc123" onAction={channel.onAction} />
      ),
      { width: 64, height: 8 },
    );
    await setup.waitForVisualIdle();
    expect(textFg(setup.captureSpans(), "model-blue")).toBe("#61afef");
  });

  it("底栏显示 agent 树：main + 子 agent 一行", async () => {
    const channel = createChannel([]);
    const st: TuiState = {
      ...channel.state,
      agents: [
        { path: "/root", status: "running", spawnedAt: null, completedAt: null },
        { path: "/root/task_1", status: "running", spawnedAt: null, completedAt: null },
      ],
    };
    const setup = await testRender(
      () => <App state={st} model="m" sessionId="s" onAction={channel.onAction} />,
      { width: 64, height: 12 },
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("● main");
    expect(frame).not.toContain("main()");
    expect(frame).toContain("( ) task_1");
  });

  it("live AgentSpawned 后底栏 agent 树刷新（曾因组件体常量 + App 布尔 memo 短路不刷新）", async () => {
    const [state, setState] = createStore<TuiState>(initState([]));
    const setup = await testRender(() => <App state={state} model="m" sessionId="s" onAction={() => {}} />, { width: 64, height: 12 });
    await setup.waitForVisualIdle();
    setState(reduceHook(state, { type: "AgentSpawned", path: "/root/task_1", parentPath: "/root", spawnedAt: 0 }));
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("● main");
    expect(frame).not.toContain("main()");
    expect(frame).toContain("( ) task_1");
  });
});