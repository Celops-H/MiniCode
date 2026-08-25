/**
 * 层 1：输入框视图——多行/光标/候选列表渲染断言。
 */
import { testRender } from "@opentui/solid";
import { it, expect } from "vitest";
import { PromptView } from "../../src/tui/view/Prompt.js";
import { createChannel } from "../../src/tui/loop.js";
import type { PromptState, SlashCandidate } from "../../src/tui/state.js";

/** 光标反色块所在列：扫描最亮的紫色 bg 空格（测试 blink=false，光标恒亮） */
function cursorColumn(setup: { captureSpans: () => { lines: Array<{ spans: Array<{ text: string; bg: { b: number }; width: number }> }> } }): number {
  const frame = setup.captureSpans();
  for (const line of frame.lines) {
    let x = 0;
    for (const span of line.spans) {
      if (span.bg && span.bg.b > 0.7 && span.text === " ") return x;
      x += span.width ?? 1;
    }
  }
  return -1;
}

const prompt = (over: Partial<PromptState> = {}): PromptState => ({
  lines: [""],
  curLine: 0,
  curCol: 0,
  history: [],
  historyIndex: -1,
  ...over,
});

it("多行输入按行渲染，光标行带反色块", async () => {
  const setup = await testRender(
    () => <PromptView prompt={prompt({ lines: ["第一行", "第二行"] })} />,
    { width: 40, height: 6 },
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("第一行");
  expect(frame).toContain("第二行");
});

it("光标块插在光标位置", async () => {
  const setup = await testRender(
    () => <PromptView prompt={prompt({ lines: ["ab"], curCol: 1 })} />,
    { width: 40, height: 4 },
  );
  await setup.waitForVisualIdle();
  // 光标反色块（空格带背景）落在 a 与 b 之间：帧里应出现 a ▸ 空格 b 的顺序
  const frame = setup.captureCharFrame();
  const aIdx = frame.indexOf("a");
  const bIdx = frame.indexOf("b");
  expect(aIdx).toBeGreaterThanOrEqual(0);
  expect(bIdx).toBeGreaterThan(aIdx);
});

it("slash 候选列表显示匹配命令与选中态", async () => {
  const candidate: SlashCandidate = { query: "/co", items: ["/compact", "/continue"], selected: 0 };
  const setup = await testRender(
    () => <PromptView prompt={prompt({ lines: ["/co"] })} candidate={candidate} />,
    { width: 40, height: 8 },
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("/compact");
  expect(frame).toContain("/continue");
  expect(frame).toContain("▸");
});

it("光标随左右键定位：curCol 移动后反色块列跟随（For+条件渲染器回归）", async () => {
  const channel = createChannel([]);
  const setup = await testRender(
    () => <PromptView prompt={channel.state.prompt} blink={false} />,
    { width: 40, height: 4 },
  );
  await setup.waitForVisualIdle();
  channel.onAction({ type: "input", text: "ab" });
  await setup.waitForVisualIdle();
  const afterInput = cursorColumn(setup);
  expect(afterInput).toBeGreaterThan(0);
  channel.onAction({ type: "cursor", dir: "left" });
  await setup.waitForVisualIdle();
  const afterLeft = cursorColumn(setup);
  expect(afterLeft).toBe(afterInput - 1);
});