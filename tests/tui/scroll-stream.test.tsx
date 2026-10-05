/**
 * 层 1：流式贴底回归（store + reconcile 就地更新路径）。
 * 生产流式路径是 createStore + reconcile，streaming 对象引用全程不变，Messages 的
 * 跟随 effect（依赖 blocks.length 与 streaming 引用）在流式增量期间不重跑，
 * 此期间的回底完全依赖 opentui sticky 吸附。
 * 本组用例按生产同款 store/reconcile/reducer 时序喂 text_delta 与 done 事件：
 * 前两例钉住「程序化回底只在流式开始与收尾各一次、期间贴底全靠 sticky」；
 * 后两例是 E135 回归：
 * 第三例按生产时序喂 text_delta，长行折行后高度继续增长、末行可见并贴底（内容列设
 * flexShrink=0 时高度会停在可用高度不再增长，修复见 Messages 的 MarkedBlock）；
 * 第四例把同样的数据一次性渲染成完成态消息块，覆盖一次性创建路径。
 */
import { createStore, reconcile } from "solid-js/store";
import { testRender } from "@opentui/solid";
import { describe, expect, it, afterEach } from "vitest";
import { Messages } from "../../src/tui/view/Messages.js";
import { messageScroller } from "../../src/tui/scroll.js";
import { reduceEvent, initState, type BlockView, type TuiState } from "../../src/tui/state.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 超宽长行（长 URL 形态）：触发过 opentui 原地更新 text 节点的高度测量封顶 */
const longLine = `https://example.com/${"x".repeat(150)}`;
const short = (from: number, to: number): string =>
  Array.from({ length: to - from }, (_, i) => `正常行${from + i}\n`).join("");

function maxScrollTop(): number {
  const box = messageScroller.box!;
  return Math.max(0, box.scrollHeight - box.viewportHeight);
}

/** 生产同款装配：store + reconcile commit + reducer。
 *  同时包装程序化回底入口（跟随 effect 与视口变化兜底都走 box.scrollToBottom），
 *  供用例验证「程序化回底次数」这一前提 */
async function setupStreaming() {
  const [state, setState] = createStore<TuiState>(initState([]));
  const setup = await testRender(
    () => <Messages blocks={state.blocks} modelLabel="m" streaming={state.streaming} />,
    { width: 60, height: 20 },
  );
  await setup.waitForVisualIdle();
  const commit = (next: TuiState): void => setState(reconcile(next));
  const box = messageScroller.box!;
  const origScrollToBottom = box.scrollToBottom.bind(box);
  let followCalls = 0;
  box.scrollToBottom = (): void => {
    followCalls++;
    origScrollToBottom();
  };
  return { setup, state, commit, follow: { get calls(): number { return followCalls; } } };
}

describe("流式贴底（reconcile 就地更新路径）", () => {
  let current: Awaited<ReturnType<typeof testRender>> | undefined;
  afterEach(() => {
    current?.renderer.destroy();
    current = undefined;
    messageScroller.box = null;
    messageScroller.userScrolled = false;
  });

  it("逐帧增量流式：程序化回底不随 delta 增长（期间靠 sticky 贴底），收尾触发一次兜底", async () => {
    const { setup, state, commit, follow } = await setupStreaming();
    current = setup;
    // 喂到内容超出视口（其间可能触发一次视口变化兜底），以此后为程序化回底基线
    for (let i = 0; i < 5; i++) {
      commit(reduceEvent(state, { type: "text_delta", text: `行${i}-a\n行${i}-b\n行${i}-c\n行${i}-d\n行${i}-e\n` }));
      await sleep(16);
    }
    await setup.waitForVisualIdle();
    const baseline = follow.calls;
    for (let i = 5; i < 30; i++) {
      commit(reduceEvent(state, { type: "text_delta", text: `行${i}-a\n行${i}-b\n行${i}-c\n行${i}-d\n行${i}-e\n` }));
      await sleep(16);
    }
    await setup.waitForVisualIdle();
    // 前提：reconcile 引用不变，跟随 effect 不随 delta 重跑——
    // 程序化回底只允许少量布局事件（视口变化兜底），不得与 25 帧 delta 同量级
    expect(follow.calls - baseline).toBeLessThanOrEqual(2);
    expect(maxScrollTop()).toBeGreaterThan(10);
    expect(messageScroller.box!.scrollTop).toBeGreaterThanOrEqual(maxScrollTop() - 1);
    // 收尾走生产 reducer 的 done 分支（落块 + streaming 消失）：blocks 增长触发一次跟随兜底
    commit(reduceEvent(state, { type: "done", stopReason: "end_turn" }));
    await setup.waitForVisualIdle();
    expect(follow.calls - baseline).toBeLessThanOrEqual(3);
    expect(messageScroller.box!.scrollTop).toBeGreaterThanOrEqual(maxScrollTop() - 1);
    expect(setup.captureCharFrame()).toContain("行29-e"); // 末行真实可见
  });

  it("突发增量流式（一帧内多条 delta）：同前提，收尾后贴底", async () => {
    const { setup, state, commit, follow } = await setupStreaming();
    current = setup;
    for (let i = 0; i < 5; i++) {
      commit(reduceEvent(state, { type: "text_delta", text: `行0-${i}\n行0-${i}b\n` }));
      await sleep(16);
    }
    await setup.waitForVisualIdle();
    const baseline = follow.calls;
    for (let i = 5; i < 30; i++) {
      for (let j = 0; j < 8; j++) {
        commit(reduceEvent(state, { type: "text_delta", text: `行${i}-${j}\n` }));
      }
      await sleep(16);
    }
    await setup.waitForVisualIdle();
    // 前提：reconcile 引用不变，跟随 effect 不随 delta 重跑——
    // 程序化回底只允许少量布局事件（视口变化兜底），不得与 25 帧 delta 同量级
    expect(follow.calls - baseline).toBeLessThanOrEqual(2);
    expect(maxScrollTop()).toBeGreaterThan(10);
    expect(messageScroller.box!.scrollTop).toBeGreaterThanOrEqual(maxScrollTop() - 1);
    commit(reduceEvent(state, { type: "done", stopReason: "end_turn" }));
    await setup.waitForVisualIdle();
    expect(follow.calls - baseline).toBeLessThanOrEqual(3);
    expect(messageScroller.box!.scrollTop).toBeGreaterThanOrEqual(maxScrollTop() - 1);
    expect(setup.captureCharFrame()).toContain("行29-7");
  });

  it("流式内容出现需折行的长行后内容继续增长、贴底且末行可见（E135 流式回归）", async () => {
    const { setup, state, commit } = await setupStreaming();
    current = setup;
    // 基线：先喂过视口高度，scrollHeight 不再被视口下限掩盖，后续增量可见
    commit(reduceEvent(state, { type: "text_delta", text: short(0, 20) }));
    await setup.waitForVisualIdle();
    const heightBefore = messageScroller.box!.scrollHeight;
    // 只加超宽长行本身：折行则该行占 4 行，不折行只占 1 行，增量差 3 行
    commit(reduceEvent(state, { type: "text_delta", text: `${longLine}\n` }));
    await setup.waitForVisualIdle();
    expect(messageScroller.box!.scrollHeight).toBeGreaterThan(heightBefore + 2);
    // 补足后续行：末行真实可见（曾表现为「最后一条消息少显示几行」），并跟随贴底
    commit(reduceEvent(state, { type: "text_delta", text: short(20, 30) }));
    await setup.waitForVisualIdle();
    expect(setup.captureCharFrame()).toContain("正常行29");
    expect(messageScroller.box!.scrollTop).toBeGreaterThanOrEqual(maxScrollTop() - 1);
  });

  it("完成态消息块含超宽长行：整段折行展示、末行可见并贴底（一次性渲染边界）", async () => {
    const blocks: BlockView[] = [
      { kind: "message", id: "a1", role: "assistant", text: `${short(0, 10)}${longLine}\n${short(10, 20)}`, thinkingCollapsed: true },
    ];
    const setup = await testRender(() => <Messages blocks={blocks} modelLabel="m" />, { width: 60, height: 20 });
    current = setup;
    await setup.waitForVisualIdle();
    const box = messageScroller.box!;
    // 一次性创建的消息块（历史消息、会话恢复重演）同数据下完整折行展示
    expect(box.scrollHeight).toBeGreaterThan(box.viewportHeight + 3);
    expect(setup.captureCharFrame()).toContain("正常行19");
    expect(box.scrollTop).toBeGreaterThanOrEqual(Math.max(0, box.scrollHeight - box.viewportHeight) - 1);
  });
});
