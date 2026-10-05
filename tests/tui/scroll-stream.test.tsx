/**
 * 层 2：流式贴底回归——生产流式路径是 createStore + reconcile 就地更新，
 * streaming 对象引用全程不变，Messages 的跟随 effect（依赖 blocks.length 与
 * streaming 引用）在流式增量期间不重跑，此期间的回底完全依赖 opentui sticky 吸附。
 * 本组用例按生产同款 store/reconcile/reducer 时序喂 text_delta 与 done 事件：
 * 前两例钉住「程序化回底只在流式开始与收尾各一次、期间贴底全靠 sticky」；
 * 第三例钉住 E135 的根源现状——流式 text 节点遇到需折行的长行后整体冻结
 * （opentui 上游问题：原地更新的 text 节点高度测量失效），修复后应改为断言贴底。
 */
import { createStore, reconcile } from "solid-js/store";
import { testRender } from "@opentui/solid";
import { describe, expect, it, afterEach } from "vitest";
import { Messages } from "../../src/tui/view/Messages.js";
import { messageScroller } from "../../src/tui/scroll.js";
import { reduceEvent, initState, type TuiState } from "../../src/tui/state.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  it("流式内容出现需折行的长行后 text 节点冻结（E135 根源现状，修复后应改为断言贴底）", async () => {
    const { setup, state, commit } = await setupStreaming();
    current = setup;
    for (let i = 0; i < 10; i++) {
      commit(reduceEvent(state, { type: "text_delta", text: `正常行${i}\n` }));
      await sleep(16);
    }
    await setup.waitForVisualIdle();
    const heightBefore = messageScroller.box!.scrollHeight;
    // 超宽长行（长 URL 形态）：触发 opentui 原地更新 text 节点的高度测量失效
    commit(reduceEvent(state, { type: "text_delta", text: `https://example.com/${"x".repeat(150)}\n` }));
    await sleep(16);
    for (let i = 10; i < 20; i++) {
      commit(reduceEvent(state, { type: "text_delta", text: `后续行${i}\n` }));
      await sleep(16);
    }
    await setup.waitForVisualIdle();
    // 现状：内容高度冻结在长行到达前，其后的增量不可见（真机上即「最后一条消息少显示几行」）
    expect(messageScroller.box!.scrollHeight).toBe(heightBefore);
    expect(setup.captureCharFrame()).not.toContain("后续行19");
  });
});
