/**
 * 层 1：输入框视图——多行/候选列表渲染断言 + 光标位置计算（D-1 终端光标不占格）。
 */
import { testRender } from "@opentui/solid";
import { it, expect, describe } from "vitest";
import { PromptView, promptCursorPosition } from "../../src/tui/view/Prompt.js";
import { createChannel } from "../../src/tui/loop.js";
import { tuiCursor } from "../../src/tui/cursor.js";
import type { PromptState, SlashCandidate } from "../../src/tui/state.js";

const prompt = (over: Partial<PromptState> = {}): PromptState => ({
  lines: [""],
  curLine: 0,
  curCol: 0,
  history: [],
  historyIndex: -1,
  sel: null,
  ...over,
});

it("多行输入按行渲染", async () => {
  const setup = await testRender(
    () => <PromptView prompt={prompt({ lines: ["第一行", "第二行"] })} />,
    { width: 40, height: 6 },
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("第一行");
  expect(frame).toContain("第二行");
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

describe("promptCursorPosition（D-1 光标终端定位不占格）", () => {
  it("单行：光标行 = 高 - 1 - 下方占用，列 = 前缀 + 光标前文本", () => {
    // H=20、1 行、光标在 "ab" 后（col2），下方占用 2（底边框+状态行）
    const pos = promptCursorPosition(prompt({ lines: ["ab"], curCol: 2 }), 20, 2);
    // 行 = 20-1+0-2+1 = 18（内容行）；列 = 4 + "ab"列宽2 = 6
    expect(pos).toEqual({ row: 18, col: 6 });
  });

  it("多行：光标在第 curLine 行（从下往上第 N-curLine 行）", () => {
    // 3 行、光标在中间行（curLine=1, curCol=0），下方占用 3（底边框+状态行+agent 1 行）
    const pos = promptCursorPosition(prompt({ lines: ["a", "b", "c"], curLine: 1, curCol: 0 }), 20, 3);
    // 行 = 20-3+1-3+1 = 16；列 = 4 + 0 = 4
    expect(pos).toEqual({ row: 16, col: 4 });
  });

  it("中文按列宽计：光标前 1 个中文字 = 2 列", () => {
    const pos = promptCursorPosition(prompt({ lines: ["中ab"], curCol: 1 }), 20, 2);
    // 光标在 "中" 后：列 = 4 + 2(中文) = 6
    expect(pos.col).toBe(6);
  });

  it("坐标不小于 1（极窄/高输入防越界）", () => {
    const pos = promptCursorPosition(prompt({ lines: Array.from({ length: 25 }, () => ""), curLine: 24 }), 10, 2);
    expect(pos.row).toBeGreaterThanOrEqual(1);
  });
});

it("光标位置随 curCol 移动（D-1：不再渲染插入字符「│」，位置由计算函数给出）", async () => {
  const channel = createChannel([]);
  const setup = await testRender(
    () => <PromptView prompt={channel.state.prompt} />,
    { width: 40, height: 4 },
  );
  await setup.waitForVisualIdle();
  channel.onAction({ type: "input", text: "ab" });
  await setup.waitForVisualIdle();
  // 渲染帧不含「│」字符（光标已改终端定位，不占列）
  expect(setup.captureCharFrame()).not.toContain("│");
  const colAtEnd = promptCursorPosition(channel.state.prompt, 4, 2).col;
  channel.onAction({ type: "cursor", dir: "left" });
  await setup.waitForVisualIdle();
  const colAfterLeft = promptCursorPosition(channel.state.prompt, 4, 2).col;
  // 左移一格：光标列前进 1（a 是 1 列宽）
  expect(colAfterLeft).toBe(colAtEnd - 1);
});

it("输入/移动后 tuiCursor 实际更新（S1 回归：组件体 createRenderEffect 响应式，非仅挂载一次）", async () => {
  const channel = createChannel([]);
  const setup = await testRender(
    () => <PromptView prompt={channel.state.prompt} />,
    { width: 40, height: 4 },
  );
  await setup.waitForVisualIdle();
  const mountCol = tuiCursor.col;
  // 输入 "ab"：光标列应 +2（组件体若只在挂载跑一次会停旧值，此断言锁响应式接线）
  channel.onAction({ type: "input", text: "ab" });
  await setup.waitForVisualIdle();
  expect(tuiCursor.col).toBe(mountCol + 2);
  // 左移一格：光标列 -1
  channel.onAction({ type: "cursor", dir: "left" });
  await setup.waitForVisualIdle();
  expect(tuiCursor.col).toBe(mountCol + 1);
});
