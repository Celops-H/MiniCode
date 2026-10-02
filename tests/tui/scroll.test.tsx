/**
 * 层 1：消息区滚动——blocks 一帧内大幅增长时视口跟随回底（sticky 吸附失效的兜底）、
 * 用户读历史时不拽回、强制回底与键盘翻页。messageScroller 是模块级共享状态，用例间重置。
 */
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { describe, expect, it, afterEach } from "vitest";
import { Messages } from "../../src/tui/view/Messages.js";
import { messageScroller, forceScrollToBottom, scrollByPages } from "../../src/tui/scroll.js";
import type { BlockView } from "../../src/tui/state.js";

/** n 条短消息块（每块 1 行正文 + 间隔） */
function blocks(n: number): BlockView[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "message",
    id: `m${i}`,
    role: "user",
    text: `消息 ${i}`,
    time: "00:00:00",
    thinkingCollapsed: true,
  }));
}

function maxScrollTop(): number {
  const box = messageScroller.box!;
  return Math.max(0, box.scrollHeight - box.viewportHeight);
}

describe("消息区滚动", () => {
  afterEach(() => {
    messageScroller.box = null;
    messageScroller.userScrolled = false;
  });

  it("blocks 一帧内增长到远超视口时视口跟随回底（sticky 脱附无自愈的兜底）", async () => {
    const [current, setCurrent] = createSignal<BlockView[]>(blocks(3));
    const setup = await testRender(() => <Messages blocks={current()} modelLabel="m" />, {
      width: 60,
      height: 20,
    });
    await setup.waitForVisualIdle();
    expect(messageScroller.box).not.toBeNull();
    // 追加 80 条：内容一帧内远超视口（实测长消息后新消息被压出视口不再显示的场景）
    setCurrent(blocks(83));
    await setup.waitForVisualIdle();
    expect(maxScrollTop()).toBeGreaterThan(10);
    expect(messageScroller.box!.scrollTop).toBeGreaterThanOrEqual(maxScrollTop() - 1);
  });

  it("用户读历史（userScrolled）时 blocks 增长不拽回底部，强制回底才恢复跟随", async () => {
    const [current, setCurrent] = createSignal<BlockView[]>(blocks(83));
    const setup = await testRender(() => <Messages blocks={current()} modelLabel="m" />, {
      width: 60,
      height: 20,
    });
    await setup.waitForVisualIdle();
    // 模拟用户已滚离底部在读历史（滚轮向上/翻页置位）
    messageScroller.userScrolled = true;
    messageScroller.box!.scrollToTop();
    await setup.waitForVisualIdle();
    const away = messageScroller.box!.scrollTop;
    setCurrent(blocks(90));
    await setup.waitForVisualIdle();
    expect(messageScroller.box!.scrollTop).toBe(away);
    // 用户提交/流式开始的强制回底：解除读历史态并贴底
    forceScrollToBottom();
    await setup.waitForVisualIdle();
    expect(messageScroller.box!.scrollTop).toBeGreaterThanOrEqual(maxScrollTop() - 1);
  });

  it("键盘翻页滚动视口并同步读历史标记；pageup 上翻置位、pagedown 到底解除", async () => {
    const [current] = createSignal<BlockView[]>(blocks(83));
    const setup = await testRender(() => <Messages blocks={current()} modelLabel="m" />, {
      width: 60,
      height: 20,
    });
    await setup.waitForVisualIdle();
    expect(messageScroller.box).not.toBeNull();
    // 已在底部（跟随态）：pagedown 触底后标记解除
    scrollByPages(1);
    expect(messageScroller.userScrolled).toBe(false);
    // pageup 上翻：视口上移半个视口，进入读历史态
    const before = messageScroller.box!.scrollTop;
    scrollByPages(-1);
    expect(messageScroller.box!.scrollTop).toBeLessThan(before);
    expect(messageScroller.userScrolled).toBe(true);
    // pagedown 回到底部：读历史态解除（跟随恢复）
    scrollByPages(2);
    expect(messageScroller.box!.scrollTop).toBeGreaterThanOrEqual(maxScrollTop() - 1);
    expect(messageScroller.userScrolled).toBe(false);
  });
});
