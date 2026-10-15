/**
 * 层 1：agent 条行数变化时光标跟随——单独成文件：opentui 的 useTerminalDimensions
 * 是跨用例残留的全局状态，混在 height=8/14/22 混合的 render.test 里会读到前例残留高度，
 * 光标行数值失真；本文件内统一 height=22，用相对差值断言。
 */
import { testRender } from "@opentui/solid";
import { createStore } from "solid-js/store";
import { describe, expect, it, afterEach, vi } from "vitest";
import { App } from "../../src/tui/view/App.js";
import { initState, type TuiState } from "../../src/tui/state.js";
import { tuiCursor } from "../../src/tui/cursor.js";

describe("agent 条变化时光标跟随", () => {
  afterEach(() => vi.useRealTimers());

  it("完成条目 10s 老化出树后，光标行随 agent 条回移（App 秒级节拍驱动 bottomRows）", async () => {
    // 假时钟须在 mount 前启用：App 的秒级 interval 用注册时的 timer 实现，mount 后才 fake 管不到它；
    // Date 一并接管，completedAt 用 fake 时钟取相对时刻
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const fakeNow = Date.now();
    const [state, setState] = createStore<TuiState>(initState([]));
    setState("agents", [
      { path: "/root", status: "running", spawnedAt: null, completedAt: null },
      // 31s 前派生、200ms 前完成：老化阈值未到，agent 条可见占 3 行
      { path: "/root/t", status: "completed", spawnedAt: fakeNow - 31_000, completedAt: fakeNow - 200 },
    ]);
    const setup = await testRender(() => <App state={state} model="m" onAction={() => {}} />, { width: 64, height: 22 });
    await setup.waitForVisualIdle();
    const rowWithAgent = tuiCursor.row;
    await vi.advanceTimersByTimeAsync(11_000);
    const rowAfterExpiry = tuiCursor.row;
    // agent 条（3 行）消失后输入框下移，光标行增大 3
    expect(rowAfterExpiry).toBe(rowWithAgent + 3);
    // 测试卫生：销毁渲染器触发 App onCleanup，停掉秒级 interval，防泄漏到其它用例
    (setup as { renderer?: { destroy?: () => void } }).renderer?.destroy?.();
  });

  it("派生出现 agent 条时光标上移避让（行数增加即重算）", async () => {
    const [state, setState] = createStore<TuiState>(initState([]));
    const setup = await testRender(() => <App state={state} model="m" onAction={() => {}} />, { width: 64, height: 22 });
    await setup.waitForVisualIdle();
    const rowNoAgent = tuiCursor.row;
    setState("agents", [
      { path: "/root", status: "running", spawnedAt: null, completedAt: null },
      { path: "/root/t", status: "running", spawnedAt: Date.now(), completedAt: null },
    ]);
    await setup.waitForVisualIdle();
    const rowWithAgent = tuiCursor.row;
    expect(rowWithAgent).toBe(rowNoAgent - 3);
    (setup as { renderer?: { destroy?: () => void } }).renderer?.destroy?.();
  });

  it("关掉 /session 全屏页后条重挂载：老化边界上条与光标占位同一拍（各起时钟相位差可到 1s）", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const t0 = Date.now();
    const [state, setState] = createStore<TuiState>(initState([]));
    const setup = await testRender(() => <App state={state} model="m" onAction={() => {}} />, { width: 64, height: 22 });
    await setup.waitForVisualIdle();
    const rowNoAgent = tuiCursor.row;
    // App 时钟随挂载起（t0）；700ms 时条随 /session 全屏页关闭才重挂载——条若自起时钟，
    // 相位从 t0+700 算起，与 App 时钟错开 700ms
    await vi.advanceTimersByTimeAsync(500);
    setState({
      ...state,
      modal: { kind: "session", sessions: [], selected: 0, action: "enter" },
      // 老化线落在 t0+1600：条自起时钟下一拍 t0+1700 就判老化，App 时钟要到 t0+2000
      agents: [
        { path: "/root", status: "running", spawnedAt: null, completedAt: null },
        { path: "/root/task_1", status: "completed", spawnedAt: t0 - 20_000, completedAt: t0 - 8400 },
      ],
    });
    await setup.waitForVisualIdle();
    await vi.advanceTimersByTimeAsync(200);
    setState({ ...state, modal: undefined });
    await setup.waitForVisualIdle();
    // t0+1800：App 时钟仍判条目可见（9400ms）——条必须还在树里，占位行数才算上它
    await vi.advanceTimersByTimeAsync(1100);
    // setInterval 被假时钟接管后渲染器帧循环停摆，captureCharFrame 取的是上一帧缓存，需显式推一帧
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("task_1");
    expect(tuiCursor.row).toBe(rowNoAgent - 3);
    // t0+2000：App 时钟判老化，条同拍消失、占位行数回让（条自起时钟时，条已在 t0+1700 消失
    // 而占位行数仍在计——行数比实际多 3 行，光标落到输入框上方）
    await vi.advanceTimersByTimeAsync(200);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("task_1");
    expect(tuiCursor.row).toBe(rowNoAgent);
    (setup as { renderer?: { destroy?: () => void } }).renderer?.destroy?.();
  });
});
