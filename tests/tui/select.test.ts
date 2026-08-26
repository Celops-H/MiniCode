/**
 * 输入框选区（B-2 Shift+方向键选择）：select 动作设锚点扩展选区、编辑/普通移动清选区、
 * selectedPromptText 取选区文本（单行/跨行/反向、码点安全）。
 */
import { describe, expect, it } from "vitest";
import { initState, reduceAction, selectedPromptText, type TuiState } from "../../src/tui/state.js";

describe("select 动作（Shift+方向键扩展输入框选区）", () => {
  it("首次 Shift+方向键：锚点固定在当前位置，光标移动扩展选区", () => {
    let s: TuiState = initState([]);
    s = reduceAction(s, { type: "input", text: "hello world" });
    // 光标在末尾(11)；Shift+← 两次：锚点=11，光标到 9 → 选中 "ld" 位置 [9,11]
    s = reduceAction(s, { type: "select", dir: "left" });
    s = reduceAction(s, { type: "select", dir: "left" });
    expect(s.prompt.sel).toEqual({ line: 0, col: 11 });
    expect(s.prompt.curLine).toBe(0);
    expect(s.prompt.curCol).toBe(9);
    expect(selectedPromptText(s.prompt)).toBe("ld");
  });

  it("反向选择：锚点固定，光标越过锚点后选区收缩到空", () => {
    let s: TuiState = initState([]);
    s = reduceAction(s, { type: "input", text: "abcdef" });
    // 锚点固定在 6（末位）；Shift+← 三次光标到 3 → 选区 [3,6]="def"
    for (let i = 0; i < 3; i++) s = reduceAction(s, { type: "select", dir: "left" });
    expect(s.prompt.sel).toEqual({ line: 0, col: 6 });
    expect(selectedPromptText(s.prompt)).toBe("def");
    // 光标向锚点回移：选区收缩，回到锚点（6）时为空
    s = reduceAction(s, { type: "select", dir: "right" });
    expect(selectedPromptText(s.prompt)).toBe("ef");
    s = reduceAction(s, { type: "select", dir: "right" });
    s = reduceAction(s, { type: "select", dir: "right" });
    expect(s.prompt.curCol).toBe(6);
    expect(selectedPromptText(s.prompt)).toBe("");
  });

  it("跨行选择：Shift+↑ 选中锚点行头到上行光标的区间", () => {
    let s: TuiState = initState([]);
    s = reduceAction(s, { type: "input", text: "abc" });
    s = reduceAction(s, { type: "newline" });
    s = reduceAction(s, { type: "input", text: "de" });
    // 光标 (1,2)，Shift+↑ → 光标 (0,2)，锚点 (1,2)
    s = reduceAction(s, { type: "select", dir: "up" });
    expect(s.prompt.sel).toEqual({ line: 1, col: 2 });
    expect(s.prompt.curLine).toBe(0);
    expect(s.prompt.curCol).toBe(2);
    // 选区 = 上行(0,2)↔下行(1,2)：第一行[2:] + 换行 + 第二行[:2]
    expect(selectedPromptText(s.prompt)).toBe("c\nde");
  });

  it("编辑清选区：select 后输入/退格，选区消失", () => {
    let s: TuiState = initState([]);
    s = reduceAction(s, { type: "input", text: "abc" });
    s = reduceAction(s, { type: "select", dir: "left" });
    expect(s.prompt.sel).not.toBeNull();
    s = reduceAction(s, { type: "input", text: "X" });
    expect(s.prompt.sel).toBeNull();
    // 再选，退格也清
    s = reduceAction(s, { type: "select", dir: "left" });
    s = reduceAction(s, { type: "backspace" });
    expect(s.prompt.sel).toBeNull();
  });

  it("普通移动光标（cursor 动作）清选区", () => {
    let s: TuiState = initState([]);
    s = reduceAction(s, { type: "input", text: "abc" });
    s = reduceAction(s, { type: "select", dir: "left" });
    expect(s.prompt.sel).not.toBeNull();
    s = reduceAction(s, { type: "cursor", dir: "right" });
    expect(s.prompt.sel).toBeNull();
  });

  it("selectedPromptText：无选区返回空串；emoji 按码点不按 UTF-16 码元（不截断代理对）", () => {
    const s = initState([]);
    expect(selectedPromptText(s.prompt)).toBe("");
    // 🎉 是代理对，2 个码元但 1 个码点：col=1 应切在码点边界，选区不含半个 emoji
    let e: TuiState = initState([]);
    e = reduceAction(e, { type: "input", text: "a🎉b" });
    e = reduceAction(e, { type: "cursor", dir: "start" });
    e = reduceAction(e, { type: "select", dir: "right" });
    expect(selectedPromptText(e.prompt)).toBe("a");
    e = reduceAction(e, { type: "select", dir: "right" });
    expect(selectedPromptText(e.prompt)).toBe("a🎉");
  });
});
