/**
 * 输入框视图（R3a + 新任务 3）：多行编辑 + 光标（反色块，闪烁）+ slash 候选列表。
 * 编辑逻辑全在 reducer（input/backspace/cursor/history/newline/send 动作），本组件只读 prompt 呈现。
 * 边界：输入区顶部边框线 + 面板底色，与消息区/状态行分隔。
 * 渲染：**不用 <For>+条件**（opentui reconciler 下 For 子项不随非 each 依赖的标量刷新——历史 bug：
 * 光标/选中态不随 curCol/curLine/selected 移动），改 createMemo 读整个 prompt 重算行列表；
 * 光标反色块随编辑位置移动并 500ms 闪烁。
 * 候选列表同此：memo 读 selected 重算，选中行 ▸ 高亮。
 */
import { createMemo, onCleanup, onMount, createSignal } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { PromptState, SelectionAnchor, SlashCandidate } from "../state.js";
import { theme } from "./theme.js";

/** 单行选中区间：锚点↔光标跨行的行内范围（[start,end) 码点下标）；无选区或空选区返回 null。
 *  行号在锚点行与焦点行之间整行选中；锚点/焦点所在行取到边界。 */
function lineSelRange(
  lineLen: number,
  i: number,
  sel: SelectionAnchor,
  curLine: number,
  curCol: number,
): [number, number] | null {
  // 归一化：锚点在前、焦点在后（支持反向选择）
  const aBefore = sel.line < curLine || (sel.line === curLine && sel.col <= curCol);
  const anchor = aBefore ? sel : { line: curLine, col: curCol };
  const focus = aBefore ? { line: curLine, col: curCol } : sel;
  if (i < anchor.line || i > focus.line) return null;
  if (anchor.line === focus.line) {
    if (i !== anchor.line || anchor.col === focus.col) return null; // 同行空选区不显示
    return [anchor.col, focus.col];
  }
  if (i === anchor.line) return [anchor.col, lineLen];
  if (i === focus.line) return [0, focus.col];
  return [0, lineLen];
}

/** slash 候选列表：memo 重算选中态（▸ 高亮随 ↑↓ 移动） */
function CandidateList(props: { candidate: SlashCandidate }): JSX.Element {
  const rows = createMemo(() =>
    props.candidate.items.map((item, i) =>
      i === props.candidate.selected ? (
        <text>
          <span style={{ bg: theme.foregroundAccent, fg: theme.text }}>▸ {item}</span>
        </text>
      ) : (
        <text fg={theme.textMuted}>  {item}</text>
      ),
    ),
  );
  return (
    <box flexDirection="column" flexShrink={0}>
      {rows()}
      <text fg={theme.textMuted}>Tab 补全 · ↑↓ 选择 · Esc 收起</text>
    </box>
  );
}

export function PromptView(props: { prompt: PromptState; candidate?: SlashCandidate; blink?: boolean; showCursor?: boolean }): JSX.Element {
  // 光标闪烁：500ms 切换一次「亮/灭」色（反色块由强调色 ⇄ 低对比）；测试可传 blink=false 关掉
  const [cursorOn, setCursorOn] = createSignal(true);
  onMount(() => {
    if (props.blink === false) return;
    const timer = setInterval(() => setCursorOn((c) => !c), 500);
    onCleanup(() => clearInterval(timer));
  });

  // 行列表：读整个 prompt（lines/curLine/curCol/sel），任何变化整体重算——光标/选区必跟上
  const rows = createMemo(() => {
    const p = props.prompt;
    const cursorFg = cursorOn() ? theme.foregroundAccent : theme.background;
    return p.lines.map((line, i) => {
      const prefix = i === 0 ? "❯ " : "  ";
      const chars = Array.from(line);
      const showCursor = i === p.curLine && props.showCursor !== false;
      const range = p.sel ? lineSelRange(chars.length, i, p.sel, p.curLine, p.curCol) : null;
      // 无选区：原样渲染（光标行插竖线）
      if (!range) {
        if (!showCursor) return <text>{prefix + line}</text>;
        const before = chars.slice(0, p.curCol).join("");
        const after = chars.slice(p.curCol).join("");
        return (
          <text>
            {prefix}
            {before}
            {/* 竖线光标（P4-5）：细竖线字符随编辑位置移动，500ms 明灭闪烁 */}
            <span style={{ fg: cursorFg }}>│</span>
            {after}
          </text>
        );
      }
      // 有选区（B-2 Shift 选择）：选中段背景抬高高亮；光标落选区焦点边界
      const [s, e] = range;
      const selSpan = (t: string) => <span style={{ bg: theme.backgroundRaised, fg: theme.text }}>{t}</span>;
      const caret = <span style={{ fg: cursorFg }}>│</span>;
      const c = p.curCol;
      const before = chars.slice(0, s).join("");
      const after = chars.slice(e).join("");
      if (!showCursor || c <= s) {
        // 光标在选区起点（反向选择到最左）：竖线在选中段前
        return (
          <text>
            {prefix}
            {before}
            {showCursor && c <= s ? caret : null}
            {selSpan(chars.slice(s, e).join(""))}
            {after}
          </text>
        );
      }
      if (c >= e) {
        // 光标在选区终点：竖线在选中段后
        return (
          <text>
            {prefix}
            {before}
            {selSpan(chars.slice(s, e).join(""))}
            {caret}
            {after}
          </text>
        );
      }
      // 光标在选中区中段：高亮段按光标断开
      return (
        <text>
          {prefix}
          {before}
          {selSpan(chars.slice(s, c).join(""))}
          {caret}
          {selSpan(chars.slice(c, e).join(""))}
          {after}
        </text>
      );
    });
  });

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
      backgroundColor={theme.backgroundPanel}
      // 上+下两条边界线贴内容（P4-5：去掉上下留白，线条与文本间距一屏可辨且随行数自然增高）
      border={["top", "bottom"]}
      borderColor={theme.border}
    >
      {props.candidate ? <CandidateList candidate={props.candidate} /> : null}
      {rows()}
    </box>
  );
}