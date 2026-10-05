/**
 * 输入框视图：多行编辑 + 光标（渲染进文本的反色块）+ slash 候选列表。
 * 编辑逻辑全在 reducer（input/backspace/cursor/history/newline/send 动作），本组件只读 prompt 呈现。
 * 边界：输入区顶部边框线 + 面板底色，与消息区/状态行分隔。
 * 渲染：**不用 <For>+条件**（opentui reconciler 下 For 子项不随非 each 依赖的标量刷新——历史 bug：
 * 光标/选中态不随 curCol/curLine/selected 移动），改 createMemo 读整个 prompt 重算行列表；
 * 选区高亮段随 curLine/curCol/sel 移动。
 * 光标：渲染进文本、常亮不闪、随帧即时跟随——光标所在字符整字反色（bg 文字色 / fg 面板底色，
 * opentui 无 reverse 属性用 bg/fg 互换等效），行尾时追加一个反色空格块；选区并存时光标段样式
 * 优先。定位每帧写入 tuiCursor（见 cursor.ts 的 attachCursorPositioning），硬件光标由帧末补发
 * 隐藏转义，输入法候选窗按写入的光标格摆放。
 */
import { createMemo, createRenderEffect } from "solid-js";
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

/** 行内分段样式：normal 普通文本；sel 选区抬高；cursor 光标反色块（选区并存时光标段优先） */
export type PromptSegmentKind = "normal" | "sel" | "cursor";

/**
 * 输入行分段：按光标段与选区段的边界把一行切成互不重叠的段（码点下标）。
 * 光标停在字符上时该字符独占 cursor 段（整字反色）；停在行尾（cursorCol ≥ 行长，
 * 含空行）时产出由调用方渲染的行尾反色空格段（seg.text 为空格、kind cursor）。
 * @param chars 行字符数组（Array.from 展开后的码点）
 * @param cursorCol 光标列（码点下标）；null = 本行无光标
 * @param sel 本行选区范围（[start,end)，lineSelRange 产出）；null = 无选区
 */
export function promptLineSegments(
  chars: string[],
  cursorCol: number | null,
  sel: [number, number] | null,
): Array<{ text: string; kind: PromptSegmentKind }> {
  const len = chars.length;
  // 分段边界：光标段首尾与选区边界都切开，各段样式互不串
  const points = new Set<number>([0, len]);
  if (cursorCol !== null && cursorCol < len) {
    points.add(cursorCol);
    points.add(cursorCol + 1);
  }
  if (sel) {
    points.add(sel[0]);
    points.add(sel[1]);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const segments: Array<{ text: string; kind: PromptSegmentKind }> = [];
  for (let k = 0; k < sorted.length - 1; k++) {
    const start = sorted[k]!;
    const end = sorted[k + 1]!;
    if (end <= start) continue;
    const inCursor = cursorCol !== null && cursorCol < len && start >= cursorCol && end <= cursorCol + 1;
    const inSel = sel !== null && start >= sel[0] && end <= sel[1];
    segments.push({
      text: chars.slice(start, end).join(""),
      kind: inCursor ? "cursor" : inSel ? "sel" : "normal",
    });
  }
  if (cursorCol !== null && cursorCol >= len) {
    segments.push({ text: " ", kind: "cursor" });
  }
  return segments;
}

/**
 * 输入框光标应处的终端行列（1-based）：行 = 终端高 - 行数 + 当前行 - 下方占用行数 + 1；
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
  /** 输入框下方占用行数（底边框+状态行+agent 条），光标定位用 */
  bottomRows?: number;
}): JSX.Element {
  const dims = useTerminalDimensions();
  // 每次渲染更新终端光标状态（组件体顶层不随 props 重跑，必须 createRenderEffect 建立响应式订阅）：
  // showCursor 时写入硬件光标应处行列（cursor.ts 的 attachCursorPositioning 每帧写出定位，
  // 输入法候选窗跟随）；隐藏态（connect key 弹窗输入）不更新——光标视觉呈现在弹窗内 key 输入区
  createRenderEffect(() => {
    if (props.showCursor !== false) {
      const pos = promptCursorPosition(props.prompt, dims().height ?? 20, props.bottomRows ?? 2);
      tuiCursor.row = pos.row;
      tuiCursor.col = pos.col;
    }
  });

  // 行列表：读整个 prompt（lines/curLine/curCol/sel），任何变化整体重算——光标块与选区高亮必跟上
  const rows = createMemo(() => {
    const p = props.prompt;
    const showCursor = props.showCursor !== false;
    return p.lines.map((line, i) => {
      const prefix = i === 0 ? "❯ " : "  ";
      const chars = Array.from(line);
      const range = p.sel ? lineSelRange(chars.length, i, p.sel, p.curLine, p.curCol) : null;
      const cursorCol = showCursor && i === p.curLine ? p.curCol : null;
      // 无光标且无选区：纯文本行
      if (cursorCol === null && !range) return <text>{prefix + line}</text>;
      const selSpan = { bg: theme.backgroundRaised, fg: theme.text };
      const cursorSpan = { bg: theme.text, fg: theme.backgroundPanel };
      return (
        <text>
          {prefix}
          {promptLineSegments(chars, cursorCol, range).map((seg, k) =>
            seg.kind === "normal" ? (
              seg.text
            ) : (
              <span style={seg.kind === "cursor" ? cursorSpan : selSpan}>{seg.text}</span>
            ),
          )}
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
      // 上+下两条边界线贴内容（去掉上下留白，线条与文本间距一屏可辨且随行数自然增高）
      border={["top", "bottom"]}
      borderColor={theme.border}
    >
      {props.candidate ? <CandidateList candidate={props.candidate} /> : null}
      {rows()}
    </box>
  );
}
