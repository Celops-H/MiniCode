/**
 * 输入框视图（R3a + 新任务 3）：多行编辑 + 光标（终端光标定位，不占格，D-1）+ slash 候选列表。
 * 编辑逻辑全在 reducer（input/backspace/cursor/history/newline/send 动作），本组件只读 prompt 呈现。
 * 边界：输入区顶部边框线 + 面板底色，与消息区/状态行分隔。
 * 渲染：**不用 <For>+条件**（opentui reconciler 下 For 子项不随非 each 依赖的标量刷新——历史 bug：
 * 光标/选中态不随 curCol/curLine/selected 移动），改 createMemo 读整个 prompt 重算行列表；
 * 选区高亮段随 curLine/curCol/sel 移动。
 * 光标（D-1=36）：不再用插入字符「│」模拟（字符必占一列、移动时挤开文字）——本组件每次渲染
 * 把光标应处的终端行列写入 tuiCursor，loop 的 postProcessFn 每帧 setCursorPosition 定位原生终端
 * 光标（绝对定位不占格，闪烁由 loop 定时器控制）。
 */
import { createMemo, onCleanup } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import type { PromptState, SelectionAnchor, SlashCandidate } from "../state.js";
import { theme } from "./theme.js";
import { colWidth } from "./fit.js";
import { tuiCursor } from "../cursor.js";

/** 单行选中区间：锚点↔光标跨行的行内范围（[start,end) 码点下标）；无选区或空选区返回 null。
 *  行号在锚点行与焦点行之间整行选中；锚点/焦点所在行取到边界。 */
export function lineSelRange(
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

/**
 * 输入框光标应处的终端行列（1-based，D-1）：行 = 终端高 - 行数 + 当前行 - 下方占用行数 + 1；
 * 列 = 左缘(1) + paddingX(1) + 前缀「❯ 」(2) + 光标前文本列宽。
 * @param bottomRows 输入框下方全部占用行数（底边框 1 + 状态行 1 + agent 条 N，由 App 传入）
 */
export function promptCursorPosition(
  prompt: PromptState,
  height: number,
  bottomRows: number,
): { row: number; col: number } {
  const N = prompt.lines.length;
  const row = height - N + prompt.curLine - bottomRows + 1;
  const before = Array.from(prompt.lines[prompt.curLine] ?? "")
    .slice(0, prompt.curCol)
    .join("");
  const col = 4 + colWidth(before);
  return { row: Math.max(1, row), col: Math.max(1, col) };
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

export function PromptView(props: {
  prompt: PromptState;
  candidate?: SlashCandidate;
  /** 是否显示光标（/connect key 弹窗输入时隐藏主输入框光标，光标移到弹窗内 key 输入区） */
  showCursor?: boolean;
  /** 输入框下方占用行数（底边框+状态行+agent 条），光标定位用（D-1） */
  bottomRows?: number;
}): JSX.Element {
  const dims = useTerminalDimensions();
  // 每次渲染更新终端光标状态：showCursor 时定位并启用（loop postProcessFn 每帧 setCursorPosition），
  // 隐藏态（connect key 弹窗输入）停用并隐藏——弹窗内 key 光标用插入字符保持
  if (props.showCursor !== false) {
    const pos = promptCursorPosition(props.prompt, dims().height ?? 20, props.bottomRows ?? 2);
    tuiCursor.row = pos.row;
    tuiCursor.col = pos.col;
    tuiCursor.enabled = true;
    tuiCursor.visible = true; // 输入/移动后立即亮，不等下一闪烁相位（审查 D-1）
  } else {
    tuiCursor.enabled = false;
    tuiCursor.visible = false;
  }
  // 卸载（全屏 /session 页隐藏输入框）复位：停闪烁定时器并隐藏，防残留光标+持续重渲（审查 D-1）
  onCleanup(() => {
    tuiCursor.enabled = false;
    tuiCursor.visible = false;
  });

  // 行列表：读整个 prompt（lines/curLine/curCol/sel），任何变化整体重算——选区高亮必跟上
  const rows = createMemo(() => {
    const p = props.prompt;
    return p.lines.map((line, i) => {
      const prefix = i === 0 ? "❯ " : "  ";
      const chars = Array.from(line);
      const range = p.sel ? lineSelRange(chars.length, i, p.sel, p.curLine, p.curCol) : null;
      // 无选区：纯文本行（光标已由终端定位，不插字符）
      if (!range) return <text>{prefix + line}</text>;
      // 有选区（B-2 Shift 选择）：选中段背景抬高高亮；光标（焦点端）已由终端定位，段内不插字符
      const [s, e] = range;
      const selSpan = (t: string) => <span style={{ bg: theme.backgroundRaised, fg: theme.text }}>{t}</span>;
      return (
        <text>
          {prefix}
          {chars.slice(0, s).join("")}
          {selSpan(chars.slice(s, e).join(""))}
          {chars.slice(e).join("")}
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
