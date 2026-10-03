/**
 * 层 1：视图渲染冒烟——opentui 渲染链就位，根组件渲染预期内容。
 * 断言用 opentui testRender 的字符帧（captureCharFrame），替代旧「帧行数组」断言方式。
 * 注意：状态行用窄宽用例钉住「窄屏不折行」——flexShrink:0 使右侧溢出被截而非换行。
 */
import { testRender } from "@opentui/solid";
import { createStore } from "solid-js/store";
import { describe, it, expect, afterEach } from "vitest";
import { App } from "../../src/tui/view/App.js";
import { createChannel } from "../../src/tui/loop.js";
import { initState, reduceHook, type TuiState } from "../../src/tui/state.js";
import { messageScroller } from "../../src/tui/scroll.js";
import { assistantMessage } from "../../src/core/index.js";

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

  it("窄屏 + 真实长标题：状态行不折行、模型名保留（右侧溢出被截）", async () => {
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

  it("状态栏当前模型名蓝色（与圆点同色 modelColor）", async () => {
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

  it("运行中状态显示黄色（进行中黄，红色只留严重错误/API error）", async () => {
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

  it("状态行显示会话标题，/rename 同步更新", async () => {
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

  it("AgentInterrupted 后底栏树显示 (×) 名、消息区显示中断活动行", async () => {
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

  it("AgentCompleted(failed) 后底栏树显示 (!) 名、消息区显示失败活动行", async () => {
    const [state, setState] = createStore<TuiState>(initState([]));
    const setup = await testRender(() => <App state={state} model="m" onAction={() => {}} />, { width: 64, height: 12 });
    await setup.waitForVisualIdle();
    setState(reduceHook(state, { type: "AgentSpawned", path: "/root/task_1", parentPath: "/root", spawnedAt: 0 }));
    await setup.waitForVisualIdle();
    // 驱动失败终态：failed 标记的 AgentCompleted——树里 ( ) → (!)，消息区出现失败活动行
    setState(
      reduceHook(state, {
        type: "AgentCompleted",
        path: "/root/task_1",
        parentPath: "/root",
        conclusion: "子代理 task_1 失败：连接超时",
        failed: true,
        completedAt: Date.now(),
      }),
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("(!) task_1");
    expect(frame).not.toContain("(√) task_1");
    expect(frame).toContain("子 agent [/root/task_1]");
    expect(frame).toContain("失败");
    expect(frame).not.toContain("完成");
  });

  it("/session 打开后全屏化生效：消息区/输入框/状态行隐藏，关闭后恢复（全屏判定须响应式）", async () => {
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

  it("切模型后状态行模型名同步：App 挂载一次读 state.modelLabel，setStore 更新后跟随（共享挂载，回归 c9c5e53）", async () => {
    // App 不传 model prop（共享挂载形态），状态行/署名读 store 的 modelLabel
    const [state, setState] = createStore<TuiState>(initState([], "", "deepseek-v4-flash"));
    const setup = await testRender(() => <App state={state} onAction={() => {}} />, { width: 64, height: 8 });
    await setup.waitForVisualIdle();
    expect(JSON.stringify(setup.captureCharFrame())).toContain("deepseek-v4-flash");
    // /model 切换后 carry 续接：只更新 store 的 modelLabel（旧实现把 modelLabel 提取成本地
    // 变量再传 prop，opentui 不响应 store 更新，状态行停留旧值）
    setState({ modelLabel: "glm-4.5-air" });
    await setup.waitForVisualIdle();
    const frame = JSON.stringify(setup.captureCharFrame());
    expect(frame).toContain("glm-4.5-air");
    expect(frame).not.toContain("deepseek-v4-flash");
  });

  it("切模型后无模型记录的历史消息署名跟随 modelLabel（Messages 内联读，同源回归）", async () => {
    // 无 meta.model 的助手消息：署名回落到 store 的 modelLabel，切模型后该署名应跟随更新
    const messages = [assistantMessage([{ type: "text", text: "历史内容" }])];
    const [state, setState] = createStore<TuiState>(initState(messages, "", "deepseek-v4-flash"));
    const setup = await testRender(() => <App state={state} onAction={() => {}} />, { width: 64, height: 10 });
    await setup.waitForVisualIdle();
    expect(JSON.stringify(setup.captureCharFrame())).toContain("deepseek-v4-flash");
    setState({ modelLabel: "glm-4.5-air" });
    await setup.waitForVisualIdle();
    const frame = JSON.stringify(setup.captureCharFrame());
    expect(frame).toContain("glm-4.5-air");
    expect(frame).not.toContain("deepseek-v4-flash");
  });

  it("状态行用量三段：有数据显示 ↑↓/缓存/上下文，无数据不渲染", async () => {
    const [state, setState] = createStore<TuiState>(initState([], "", "m"));
    const setup = await testRender(() => <App state={state} onAction={() => {}} />, { width: 110, height: 8 });
    await setup.waitForVisualIdle();
    // 无数据：用量区不渲染
    expect(setup.captureCharFrame()).not.toContain("缓存");

    // 有数据：↑ 10.3k ↓ 45.6k · 缓存 87%（9000/10350 ≈ 87%）· 上下文 62%
    setState({
      usage: { inputTokens: 10350, outputTokens: 45600, cacheReadTokens: 9000 },
      contextTokens: 62000,
      contextWindow: 100000,
      compactThreshold: 88000,
    });
    await setup.waitForVisualIdle();
    const frame = JSON.stringify(setup.captureCharFrame());
    expect(frame).toContain("↑ 10.3k ↓ 45.6k");
    expect(frame).toContain("缓存 87%");
    expect(frame).toContain("上下文 62%");

    // 未到压缩线：水位弱灰；到达压缩线（≥ threshold）：警示色=warning 红（theme.warning 并入红）
    setState({ contextTokens: 50000 });
    await setup.waitForVisualIdle();
    expect(textFgContaining(setup.captureSpans(), "上下文 50%")).toBe("#8f9096");
    setState({ contextTokens: 90000 });
    await setup.waitForVisualIdle();
    expect(textFgContaining(setup.captureSpans(), "上下文 90%")).toBe("#e06c75");
  });
});

describe("输入框高度与消息区让位", () => {
  afterEach(() => {
    messageScroller.box = null;
    messageScroller.userScrolled = false;
  });

  /** 30 条助手消息撑出滚动（每条 1 行正文），返回 store 与setter */
  function scrollableState() {
    const messages = Array.from({ length: 30 }, (_, i) =>
      assistantMessage([{ type: "text", text: `模型回复内容 ${i}` }]),
    );
    return createStore<TuiState>(initState(messages, "", "m"));
  }

  function maxScrollTop(): number {
    const box = messageScroller.box!;
    return Math.max(0, box.scrollHeight - box.viewportHeight);
  }

  /** 构造「内部手动滚动标记残留」态：滚离底部置位 opentui 内部标记后，
   *  本模块跟随标记被复位。生产中该残留由内容一帧内跳变的吸附误判造成，
   *  空闲期没有内容事件自愈——输入框长高时视口收缩，opentui 自带吸附不生效 */
  async function staleStickyState(
    setup: Awaited<ReturnType<typeof testRender>>,
  ): Promise<void> {
    messageScroller.userScrolled = true;
    messageScroller.box!.scrollToTop();
    await setup.waitForVisualIdle();
    messageScroller.userScrolled = false;
    await setup.waitForVisualIdle();
  }

  it("输入框长高后消息区视口收缩并跟随回底，最后几行始终可见", async () => {
    const [state, setState] = scrollableState();
    const setup = await testRender(() => <App state={state} onAction={() => {}} />, {
      width: 60,
      height: 20,
    });
    await setup.waitForVisualIdle();
    await staleStickyState(setup);
    // 输入框长高到 5 行：消息区让位收缩，且跟随回底——底部消息不被挡
    setState({ prompt: { ...state.prompt, lines: ["a", "b", "c", "d", "e"], curLine: 4, curCol: 1 } });
    await setup.waitForVisualIdle();
    expect(setup.captureCharFrame()).toContain("模型回复内容 29");
    expect(messageScroller.box!.viewportHeight).toBeLessThan(16);
    expect(messageScroller.box!.scrollTop).toBeGreaterThanOrEqual(maxScrollTop() - 1);
  });

  it("输入框回落单行后同步收拢回底，不留空行不跳动", async () => {
    const [state, setState] = scrollableState();
    const setup = await testRender(() => <App state={state} onAction={() => {}} />, {
      width: 60,
      height: 20,
    });
    await setup.waitForVisualIdle();
    setState({ prompt: { ...state.prompt, lines: ["a", "b", "c", "d", "e"], curLine: 4, curCol: 1 } });
    await setup.waitForVisualIdle();
    await staleStickyState(setup);
    const grownViewport = messageScroller.box!.viewportHeight;
    // 回落单行：视口扩张回原高度，跟随态回底——底部消息贴着输入框上沿显示
    setState({ prompt: { ...state.prompt, lines: ["a"], curLine: 0, curCol: 1 } });
    await setup.waitForVisualIdle();
    expect(messageScroller.box!.viewportHeight).toBeGreaterThan(grownViewport);
    expect(setup.captureCharFrame()).toContain("模型回复内容 29");
    expect(messageScroller.box!.scrollTop).toBeGreaterThanOrEqual(maxScrollTop() - 1);
  });

  it("读历史态（userScrolled）输入框长高不拽回底部", async () => {
    // 本例锁门控：无 userScrolled 判断时兜底会把读历史视口拽回底部。
    // 有修复与否 opentui 自带吸附都因内部标记置位不动作，故此例不用于证伪兜底本身
    const [state, setState] = scrollableState();
    const setup = await testRender(() => <App state={state} onAction={() => {}} />, {
      width: 60,
      height: 20,
    });
    await setup.waitForVisualIdle();
    messageScroller.userScrolled = true;
    messageScroller.box!.scrollToTop();
    await setup.waitForVisualIdle();
    setState({ prompt: { ...state.prompt, lines: ["a", "b", "c"], curLine: 2, curCol: 1 } });
    await setup.waitForVisualIdle();
    expect(messageScroller.box!.scrollTop).toBe(0);
  });
});
