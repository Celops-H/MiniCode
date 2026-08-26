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

/** 取首个包含 text 的 span 的 fg（span 可能被拆分时用包含匹配） */
function textFgContaining(frame: { lines: Array<{ spans: Array<{ text: string; fg?: unknown }> }> }, text: string): string | undefined {
  for (const line of frame.lines) {
    for (const span of line.spans) {
      if (span.text.includes(text)) {
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
        <App state={channel.state} model="test-model" onAction={channel.onAction} />
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
        <App state={channel.state} model="test-model" onAction={channel.onAction} />
      ),
      { width: 44, height: 8 },
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    // 模型名与权限模式 chip 保留在同一行（flexShrink:0 右侧溢出被截而非换行）
    expect(frame).toContain("test-model");
    expect(frame).toContain("模式[default]");
  });

  it("窄屏 + 真实长标题：状态行不折行、模型名保留（右侧溢出被截，UI-SPEC 既有行为）", async () => {
    const [state, setState] = createStore<TuiState>(initState([], "重构 partition 并发分区方案"));
    const setup = await testRender(
      () => (
        <App state={state} model="deepseek-v4-flash" onAction={() => {}} />
      ),
      { width: 44, height: 8 },
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    // 长标题 + 窄屏：状态行不折行、模型名（左盒最前）保留、标题列宽截断后仍可见；模式 chip 随右侧溢出被截
    expect(frame).toContain("deepseek-v4-flash");
    expect(frame).toContain("会话 重构 partition");
  });

  it("状态栏当前模型名蓝色（与圆点同色 modelColor，用户复核：模型名应为蓝）", async () => {
    const channel = createChannel([]);
    const setup = await testRender(
      () => (
        <App state={channel.state} model="model-blue" onAction={channel.onAction} />
      ),
      { width: 64, height: 8 },
    );
    await setup.waitForVisualIdle();
    expect(textFg(setup.captureSpans(), "model-blue")).toBe("#61afef");
  });

  it("运行中状态显示黄色（E-2=66：进行中黄，红色只留严重错误/API error）", async () => {
    const [state, setState] = createStore<TuiState>(initState([]));
    setState({ status: "running" });
    const setup = await testRender(
      () => <App state={state} model="m" onAction={() => {}} />,
      { width: 64, height: 8 },
    );
    await setup.waitForVisualIdle();
    expect(setup.captureCharFrame()).toContain("▶ 运行中");
    expect(textFgContaining(setup.captureSpans(), "运行中（Esc 打断")).toBe("#e5c07b");
  });

  it("状态行显示会话标题，/rename 同步更新（用户复核：会话名应随 /rename 变）", async () => {
    const [state, setState] = createStore<TuiState>(initState([], "重构 partition"));
    const setup = await testRender(
      () => (
        <App state={state} model="m" onAction={() => {}} />
      ),
      { width: 64, height: 8 },
    );
    await setup.waitForVisualIdle();
    expect(setup.captureCharFrame()).toContain("会话 重构 partition");
    // /rename 更新 store title → 状态行会话名跟着变（非响应式会停旧值，此断言锁响应式）
    setState({ title: "新标题" });
    await setup.waitForVisualIdle();
    expect(setup.captureCharFrame()).toContain("会话 新标题");
    expect(setup.captureCharFrame()).not.toContain("会话 重构 partition");
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
      () => <App state={st} model="m" onAction={channel.onAction} />,
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
    const setup = await testRender(() => <App state={state} model="m" onAction={() => {}} />, { width: 64, height: 12 });
    await setup.waitForVisualIdle();
    setState(reduceHook(state, { type: "AgentSpawned", path: "/root/task_1", parentPath: "/root", spawnedAt: 0 }));
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("● main");
    expect(frame).not.toContain("main()");
    expect(frame).toContain("( ) task_1");
  });

  it("AgentInterrupted 后底栏树显示 (×) 名、消息区显示中断活动行（A-5 打断显示）", async () => {
    const [state, setState] = createStore<TuiState>(initState([]));
    const setup = await testRender(() => <App state={state} model="m" onAction={() => {}} />, { width: 64, height: 12 });
    await setup.waitForVisualIdle();
    setState(reduceHook(state, { type: "AgentSpawned", path: "/root/task_1", parentPath: "/root", spawnedAt: 0 }));
    await setup.waitForVisualIdle();
    // 打断：树里 ( ) → (×)，消息区出现中断活动行（completedAt 注入使树可见期内展示）
    setState(
      reduceHook(state, {
        type: "AgentInterrupted",
        path: "/root/task_1",
        parentPath: "/root",
        completedAt: Date.now(),
      }),
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("(×) task_1");
    expect(frame).not.toContain("( ) task_1");
    expect(frame).toContain("子 agent [/root/task_1]");
    expect(frame).toContain("中断");
  });

  it("/session 打开后全屏化生效：消息区/输入框/状态行隐藏，关闭后恢复（审查 S-1 回归：全屏判定须响应式）", async () => {
    const [state, setState] = createStore<TuiState>(initState([], "标题"));
    const setup = await testRender(() => <App state={state} model="m" onAction={() => {}} />, { width: 64, height: 14 });
    await setup.waitForVisualIdle();
    // 挂载后打开 /session 弹窗：消息区/输入框/状态行全部隐藏、只渲染会话列表
    setState({
      ...state,
      modal: {
        kind: "session",
        sessions: [{ id: "ab3f90", title: "其它会话", model: "deepseek-chat", updatedAt: "now", sizeBytes: 1024 }],
        selected: 0,
        action: "enter",
      },
    });
    await setup.waitForVisualIdle();
    const fullscreenFrame = setup.captureCharFrame();
    expect(fullscreenFrame).toContain("会话列表"); // 全屏页出现
    expect(fullscreenFrame).not.toContain("● 空闲"); // 状态行隐藏
    expect(fullscreenFrame).not.toContain("❯"); // 输入框隐藏
    expect(fullscreenFrame).not.toContain("开始对话吧"); // 消息区空态提示隐藏
    // 关闭弹窗回主界面
    setState({ ...state, modal: undefined });
    await setup.waitForVisualIdle();
    const restored = setup.captureCharFrame();
    expect(restored).toContain("● 空闲"); // 状态行恢复
    expect(restored).not.toContain("会话列表");
  });
});