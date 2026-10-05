/**
 * 层 1：输入框视图——多行/候选列表渲染断言 + 光标（渲染进文本的反色块）与位置计算。
 */
import { testRender } from "@opentui/solid";
import { it, expect, describe, afterEach } from "vitest";
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

/** 按文本精确匹配找 span，返回其 fg/bg 十六进制色（RGBA buffer → #rrggbb）；找不到属性为 undefined */
function spanColorOf(
  spans: { lines: Array<{ spans: Array<{ text: string; fg?: unknown; bg?: unknown }> }> },
  text: string,
): { fg?: string; bg?: string } {
  const hex = (color: unknown): string | undefined => {
    const buf = (color as { buffer?: ArrayLike<number> } | undefined)?.buffer;
    if (!buf) return undefined;
    return `#${[0, 1, 2].map((i) => (buf[i] ?? 0).toString(16).padStart(2, "0")).join("")}`;
  };
  for (const line of spans.lines) {
    for (const span of line.spans) {
      if (span.text === text) return { fg: hex(span.fg), bg: hex(span.bg) };
    }
  }
  return {};
}

/** 按包含匹配找首个 span（同样式相邻内容会被渲染器合并，行尾填充带空格） */
function spanColorContaining(
  spans: { lines: Array<{ spans: Array<{ text: string; fg?: unknown; bg?: unknown }> }> },
  needle: string,
): { fg?: string; bg?: string } {
  const hex = (color: unknown): string | undefined => {
    const buf = (color as { buffer?: ArrayLike<number> } | undefined)?.buffer;
    if (!buf) return undefined;
    return `#${[0, 1, 2].map((i) => (buf[i] ?? 0).toString(16).padStart(2, "0")).join("")}`;
  };
  for (const line of spans.lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return { fg: hex(span.fg), bg: hex(span.bg) };
    }
  }
  return {};
}

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

describe("promptCursorPosition（光标终端定位不占格）", () => {
  it("单行：光标行 = 高 - 1 - 下方占用，列 = 前缀 + 光标前文本", () => {
    // 宽 40（内容 38 列不折行）、H=20、1 行、光标在 "ab" 后（col2），下方占用 2（底边框+状态行）
    const pos = promptCursorPosition(prompt({ lines: ["ab"], curCol: 2 }), 40, 20, 2);
    // 行 = 20-1+0-2+1 = 18（内容行）；列 = 4 + "ab"列宽2 = 6
    expect(pos).toEqual({ row: 18, col: 6 });
  });

  it("多行：光标在第 curLine 行（从下往上第 N-curLine 行）", () => {
    // 3 行、光标在中间行（curLine=1, curCol=0），下方占用 3（底边框+状态行+agent 1 行）
    const pos = promptCursorPosition(prompt({ lines: ["a", "b", "c"], curLine: 1, curCol: 0 }), 40, 20, 3);
    // 行 = 20-3+1-3+1 = 16；列 = 4 + 0 = 4
    expect(pos).toEqual({ row: 16, col: 4 });
  });

  it("中文按列宽计：光标前 1 个中文字 = 2 列", () => {
    const pos = promptCursorPosition(prompt({ lines: ["中ab"], curCol: 1 }), 40, 20, 2);
    // 光标在 "中" 后：列 = 4 + 2(中文) = 6
    expect(pos.col).toBe(6);
  });

  it("坐标不小于 1（极窄/高输入防越界）", () => {
    const pos = promptCursorPosition(prompt({ lines: Array.from({ length: 25 }, () => ""), curLine: 24 }), 40, 10, 2);
    expect(pos.row).toBeGreaterThanOrEqual(1);
  });

  it("单行超宽折行：光标折算到续行的显示行列", () => {
    // 宽 30 → 内容 28 列，首行扣前缀 26 列；36 字符折成 [0,26) + [26,36) 两条视觉行
    const line = "abcdefghijklmnopqrstuvwxyz0123456789";
    const pos = promptCursorPosition(prompt({ lines: [line], curCol: 30 }), 30, 20, 2);
    // 光标在续行 "0123" 后 → 列 = 2 + 4 = 6（旧算法按逻辑列算出 34，超出终端宽）；行 = 20 - 2 - 0 = 18
    expect(pos).toEqual({ row: 18, col: 6 });
  });

  it("前文折行后光标行随视觉行数上移（旧行数公式少算折出的行）", () => {
    // 行 0 折成 2 条视觉行：视觉行共 3 条，光标在第 1 条，下方还有续行与行 1
    const pos = promptCursorPosition(prompt({ lines: ["x".repeat(30), "abc"], curLine: 0, curCol: 3 }), 30, 20, 2);
    // 行 = 20 - 2 - 下方 2 行 = 16（旧算法 17）；列 = 2 + 3 + 前缀 2 = 7
    expect(pos).toEqual({ row: 16, col: 7 });
  });

  it("中文宽字符行尾放不下整字下移，光标列从续行行首起算", () => {
    // 15 个中文 30 列；首行扣前缀 26 列 → 13 个中文填满首行，第 14 字整字挪到续行
    const pos = promptCursorPosition(prompt({ lines: ["一二三四五六七八九十甲乙丙丁戊"], curCol: 13 }), 30, 20, 2);
    // 光标在续行首字符上 → 列 = 2 + 0 = 2；行 = 20 - 2 - 0 = 18
    expect(pos).toEqual({ row: 18, col: 2 });
  });

  it("行尾光标块放不下：补一条独占行，光标落新行行首", () => {
    // 13 个中文恰填满首行 26 列，行尾反色块占 1 列放不下 → 补出光标块独占行
    const pos = promptCursorPosition(prompt({ lines: ["一二三四五六七八九十甲乙丙丁"], curCol: 13 }), 30, 20, 2);
    expect(pos).toEqual({ row: 18, col: 2 });
  });

  it("行尾光标块放得下：挂本行行尾", () => {
    // 12 个中文 24 列，行尾块占 1 列仍有余量 → 列 = 2 + 24 + 前缀 2 = 28
    const pos = promptCursorPosition(prompt({ lines: ["一二三四五六七八九十甲乙"], curCol: 12 }), 30, 20, 2);
    expect(pos).toEqual({ row: 18, col: 28 });
  });
});

it("光标位置随 curCol 移动（不再渲染插入字符「│」，位置由计算函数给出）", async () => {
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
  const colAtEnd = promptCursorPosition(channel.state.prompt, 40, 4, 2).col;
  channel.onAction({ type: "cursor", dir: "left" });
  await setup.waitForVisualIdle();
  const colAfterLeft = promptCursorPosition(channel.state.prompt, 40, 4, 2).col;
  // 左移一格：光标列前进 1（a 是 1 列宽）
  expect(colAfterLeft).toBe(colAtEnd - 1);
});

it("输入/移动后 tuiCursor 实际更新（组件体 createRenderEffect 响应式，非仅挂载一次）", async () => {
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

describe("光标渲染进文本（反色块，常亮不闪）", () => {
  // 光标反色：bg 文字色 / fg 面板底色（opentui 无 reverse 属性，bg/fg 互换等效）
  const cursorBlock = { bg: "#ececf0", fg: "#101013" };

  it("光标停在字符上：该字符整字反色", async () => {
    const setup = await testRender(
      () => <PromptView prompt={prompt({ lines: ["abc"], curCol: 1 })} />,
      { width: 40, height: 6 },
    );
    await setup.waitForVisualIdle();
    expect(spanColorOf(setup.captureSpans(), "b")).toEqual(cursorBlock);
  });

  it("光标停在行尾：追加一个空格宽的反色实心块", async () => {
    const setup = await testRender(
      () => <PromptView prompt={prompt({ lines: ["ab"], curCol: 2 })} />,
      { width: 40, height: 6 },
    );
    await setup.waitForVisualIdle();
    expect(spanColorOf(setup.captureSpans(), " ")).toEqual(cursorBlock);
  });

  it("空行（空输入框）光标：仅行尾反色实心块", async () => {
    const setup = await testRender(
      () => <PromptView prompt={prompt()} />,
      { width: 40, height: 6 },
    );
    await setup.waitForVisualIdle();
    expect(spanColorOf(setup.captureSpans(), " ")).toEqual(cursorBlock);
  });

  it("选区并存：光标段样式优先于选区段", async () => {
    // 跨行选区锚在下一行行首：光标行（锚行）选区范围 [1,4) 盖住光标字符「b」，
    // 光标段仍反色、选区段背景抬高（同行选区以光标为端点，光标字符恒在边界外，无重叠场景）
    const setup = await testRender(
      () => (
        <PromptView
          prompt={prompt({ lines: ["abcd", "ef"], curLine: 0, curCol: 1, sel: { line: 1, col: 0 } })}
        />
      ),
      { width: 40, height: 7 },
    );
    await setup.waitForVisualIdle();
    const spans = setup.captureSpans();
    expect(spanColorOf(spans, "b")).toEqual(cursorBlock);
    expect(spanColorOf(spans, "cd")?.bg).toBe("#1c1c22");
  });

  it("反向跨行选区（锚在上一行，光标行为焦点行）：光标段反色、焦点行选区段抬高", async () => {
    // 锚在上一行：光标行选区范围 [0,1) 不含光标字符「f」，光标段照常反色
    const setup = await testRender(
      () => (
        <PromptView
          prompt={prompt({ lines: ["abcd", "ef"], curLine: 1, curCol: 1, sel: { line: 0, col: 1 } })}
        />
      ),
      { width: 40, height: 7 },
    );
    await setup.waitForVisualIdle();
    const spans = setup.captureSpans();
    expect(spanColorOf(spans, "f")).toEqual(cursorBlock);
    expect(spanColorOf(spans, "e")?.bg).toBe("#1c1c22");
  });

  it("showCursor=false（connect key 弹窗态）：不渲染光标块", async () => {
    const setup = await testRender(
      () => <PromptView prompt={prompt({ lines: ["ab"], curCol: 1 })} showCursor={false} />,
      { width: 40, height: 6 },
    );
    await setup.waitForVisualIdle();
    const spans = setup.captureSpans();
    expect(spanColorOf(spans, "a")?.bg).toBeUndefined();
    expect(spanColorOf(spans, "b")?.bg).toBeUndefined();
    expect(spanColorOf(spans, " ")?.bg).toBeUndefined();
  });
});

describe("showCursor 与 tuiCursor.active（光标定位写入门控）", () => {
  afterEach(() => {
    tuiCursor.active = true;
    tuiCursor.row = 1;
    tuiCursor.col = 1;
  });

  it("默认态 active=true：输入框掌管光标定位", async () => {
    const setup = await testRender(() => <PromptView prompt={prompt({ lines: ["ab"], curCol: 1 })} />, {
      width: 40,
      height: 6,
    });
    await setup.waitForVisualIdle();
    expect(tuiCursor.active).toBe(true);
  });

  it("showCursor=false 置 inactive：输入框不管光标，停写定位", async () => {
    const setup = await testRender(
      () => <PromptView prompt={prompt({ lines: ["ab"], curCol: 1 })} showCursor={false} />,
      { width: 40, height: 6 },
    );
    await setup.waitForVisualIdle();
    expect(tuiCursor.active).toBe(false);
  });
});

it("折行后光标块渲染位置与 promptCursorPosition 折算一致（渲染与定位同源）", async () => {
  // 宽 30：36 字符行折成 2 条视觉行，光标在 curCol=30 → 续行 "0123" 后；帧内反色块应恰在该格
  const p = prompt({ lines: ["abcdefghijklmnopqrstuvwxyz0123456789"], curCol: 30 });
  const setup = await testRender(() => <PromptView prompt={p} />, { width: 30, height: 8 });
  await setup.waitForVisualIdle();
  const spans = setup.captureSpans();
  const isCursorBlock = (span: { bg?: unknown }): boolean => {
    const buf = (span.bg as { buffer?: ArrayLike<number> } | undefined)?.buffer;
    if (!buf) return false;
    return `#${[0, 1, 2].map((i) => (buf[i] ?? 0).toString(16).padStart(2, "0")).join("")}` === "#ececf0";
  };
  // 逐帧行扫描：块所在行 = 行号+1，列 = 1 + 行内前序 span 宽度和（span 首格含 padding 列）
  let block: { row: number; col: number } | null = null;
  for (let i = 0; i < spans.lines.length && !block; i++) {
    let cols = 0;
    for (const span of spans.lines[i]!.spans) {
      if (isCursorBlock(span)) {
        block = { row: i + 1, col: 1 + cols };
        break;
      }
      cols += span.width;
    }
  }
  expect(block).not.toBeNull();
  // 折行后续行在帧第 3 行（上边框 1 + 视觉行 2）；promptCursorPosition 的 bottomRows 取
  // 高 8 - 视觉行 2 - 上边框 1 = 5，使公式对齐孤立渲染的帧内绝对行
  expect(promptCursorPosition(p, 30, 8, 5)).toEqual({ row: block!.row, col: block!.col });
  expect(block).toEqual({ row: 3, col: 6 });
});

it("选区跨折行块：各块裁剪自身区间，光标处样式压过选区", async () => {
  // 宽 30：36 字符折为 [0,26) + [26,36) 两条视觉行；选区 [2,30) 跨两块，光标 curCol=30 停在 "4" 上
  const p = prompt({ lines: ["abcdefghijklmnopqrstuvwxyz0123456789"], curCol: 30, sel: { line: 0, col: 2 } });
  const setup = await testRender(() => <PromptView prompt={p} />, { width: 30, height: 8 });
  await setup.waitForVisualIdle();
  const spans = setup.captureSpans();
  const selSpan = { bg: "#1c1c22" };
  const cursorSpan = { bg: "#ececf0" };
  // 混合内容行普通段的 bg 是面板底色（框背景垫底），未抬高
  const panelSpan = { bg: "#101013" };
  // 首块：选区前的 "ab" 正常，选区段抬到行尾（同样式相邻内容被渲染器合并，按包含匹配）
  expect(spanColorContaining(spans, "❯ ab")).toMatchObject(panelSpan);
  expect(spanColorContaining(spans, "cdefghijklmnopqrstuvwxyz")).toMatchObject(selSpan);
  // 续块：选区裁剪为 "0123" 抬高、光标字符 "4" 整字反色压过选区、其后正常
  expect(spanColorContaining(spans, "0123")).toMatchObject(selSpan);
  expect(spanColorContaining(spans, "4")).toMatchObject(cursorSpan);
  expect(spanColorContaining(spans, "56789")).toMatchObject(panelSpan);
});
