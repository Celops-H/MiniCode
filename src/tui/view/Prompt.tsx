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
 * 折行：逻辑行按输入框可用宽度软折行（layoutPrompt/wrapByCols，宽字符不劈开），渲染逐视觉行
 * 输出、光标定位折算显示行列，两处共用同一份布局——不依赖渲染器自身的折行行为，长行折行后
 * 光标格与反色块不错位（渲染器默认按词折行，行为不透明不可依赖）。
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
 * 输入框光标应处的终端行列（1-based）：先按输入框可用宽度把逻辑行软折行成视觉行，
 * 再折算显示行列——行 = 终端高 - 视觉行总数 + 光标视觉行 - 下方占用行数 + 1；
 * 列 = 左缘 + paddingX(1) + 块内偏移（逻辑行首块再计前缀「❯ 」2 列）。
 * 切行规则见 layoutPrompt：渲染与定位共用同一份布局，写出的光标格与反色块一致。
 * @param width 终端宽（输入框内容宽 = width - 2）
 * @param bottomRows 输入框下方全部占用行数（底边框 1 + 状态行 1 + agent 条 N，由 App 传入）
 */
export function promptCursorPosition(
  prompt: PromptState,
  width: number,
  height: number,
  bottomRows: number,
): { row: number; col: number } {
  const layout = layoutPrompt(prompt, width, true);
  if (!layout.cursor) return { row: 1, col: 1 };
  const fromBottom = layout.rows.length - 1 - layout.cursor.row;
  return { row: Math.max(1, height - bottomRows - fromBottom), col: Math.max(1, layout.cursor.col) };
}

/** 输入行软折行：按可用列宽把逻辑行（码点数组）切成视觉行，返回各行的码点区间 [start,end)。
 *  first 首行可用列（已扣前缀）、rest 续行可用列；宽字符行尾放不下整字挪到下一行，不在行中劈开。
 *  空行返回一条空区间（占一视觉行）。 */
export function wrapByCols(ch: string[], first: number, rest: number): Array<[number, number]> {
  const rows: Array<[number, number]> = [];
  let start = 0;
  let used = 0;
  let avail = first;
  for (let i = 0; i < ch.length; i++) {
    const cw = colWidth(ch[i]!);
    if (used + cw > avail && i > start) {
      rows.push([start, i]);
      start = i;
      used = 0;
      avail = rest;
    }
    used += cw;
  }
  rows.push([start, ch.length]);
  return rows;
}

/** 软折行后的视觉行：区间 [start,end) 相对所属逻辑行的码点下标 */
interface PromptVisualRow {
  line: number;
  start: number;
  end: number;
  /** 逻辑行首块带「❯ 」/「  」前缀；续行顶格（与折行呈现一致） */
  prefixed: boolean;
  /** 行尾光标块挂在本行末（光标在行尾且本行放得下） */
  endBlock: boolean;
  /** 行尾光标块放不下时补出的独占行（只含反色空格，无前缀无正文） */
  cursorBlock: boolean;
}

/**
 * 输入框视觉布局：把每条逻辑行按可用宽度软折行为视觉行，并给出光标应处的视觉行与终端列。
 * 渲染（rows memo）与光标定位（promptCursorPosition）共用本结果，光标格与反色块同源一致。
 * 内容宽 W = width - 2（paddingX 两侧各 1 列），逻辑行首块再扣前缀 2 列。
 * 光标停在字符上落覆盖该字符的块；停在行尾时反色块占 1 列，末行放不下补一条独占行。
 */
function layoutPrompt(
  prompt: PromptState,
  width: number,
  showCursor: boolean,
): { rows: PromptVisualRow[]; cursor: { row: number; col: number } | null } {
  const W = Math.max(1, width - 2);
  const first = Math.max(1, W - 2);
  const rows: PromptVisualRow[] = [];
  let cursor: { row: number; col: number } | null = null;
  prompt.lines.forEach((line, i) => {
    const chars = Array.from(line);
    const chunks = wrapByCols(chars, first, W);
    const manages = showCursor && i === prompt.curLine;
    for (let k = 0; k < chunks.length; k++) {
      const [s, e] = chunks[k]!;
      const isLast = k === chunks.length - 1;
      if (manages && prompt.curCol < chars.length && prompt.curCol >= s && prompt.curCol < e) {
        // 光标停在字符上：列 = padding(1) + 块内偏移 + 前缀（首块 2 列）
        const offset = colWidth(chars.slice(s, prompt.curCol).join(""));
        cursor = { row: rows.length, col: 2 + offset + (s === 0 ? 2 : 0) };
      }
      let endBlock = false;
      if (manages && prompt.curCol >= chars.length && isLast) {
        const rowW = colWidth(chars.slice(s, e).join(""));
        const avail = chunks.length === 1 ? first : W;
        endBlock = rowW + 1 <= avail;
        if (endBlock) cursor = { row: rows.length, col: 2 + rowW + (s === 0 ? 2 : 0) };
      }
      rows.push({ line: i, start: s, end: e, prefixed: s === 0, endBlock, cursorBlock: false });
      if (manages && prompt.curCol >= chars.length && isLast && !endBlock) {
        rows.push({ line: i, start: e, end: e, prefixed: false, endBlock: false, cursorBlock: true });
        cursor = { row: rows.length - 1, col: 2 };
      }
    }
  });
  return { rows, cursor };
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
  // 输入法候选窗跟随）；隐藏态（connect key 弹窗输入）不归输入框管——置 inactive 停写定位，
  // 残留定位会把候选窗锚在输入框旧位（光标格留在弹窗实际内容处）
  createRenderEffect(() => {
    if (props.showCursor !== false) {
      const pos = promptCursorPosition(
        props.prompt,
        dims().width ?? 80,
        dims().height ?? 20,
        props.bottomRows ?? 2,
      );
      tuiCursor.row = pos.row;
      tuiCursor.col = pos.col;
      tuiCursor.active = true;
    } else {
      tuiCursor.active = false;
    }
  });

  // 行列表：读整个 prompt（lines/curLine/curCol/sel），任何变化整体重算——光标块与选区高亮必跟上。
  // 视觉行由 layoutPrompt 软折行产出（与 promptCursorPosition 同源），逐块渲染保证块不超宽、
  // 不依赖渲染器自身的折行行为，长行折行后光标块与硬件光标定位一致
  const rows = createMemo(() => {
    const p = props.prompt;
    const showCursor = props.showCursor !== false;
    const layout = layoutPrompt(p, dims().width ?? 80, showCursor);
    return layout.rows.map((r) => {
      const selSpan = { bg: theme.backgroundRaised, fg: theme.text };
      const cursorSpan = { bg: theme.text, fg: theme.backgroundPanel };
      // 行尾光标块放不下补出的独占行：只含反色空格
      if (r.cursorBlock) {
        return (
          <text>
            <span style={cursorSpan}> </span>
          </text>
        );
      }
      const prefix = r.prefixed ? (r.line === 0 ? "❯ " : "  ") : "";
      const chars = Array.from(p.lines[r.line] ?? "");
      const range = p.sel ? lineSelRange(chars.length, r.line, p.sel, p.curLine, p.curCol) : null;
      // 选区裁到本块（码点下标随块平移，空交集为无选区）
      const clipped: [number, number] | null = range
        ? [Math.max(range[0], r.start) - r.start, Math.min(range[1], r.end) - r.start]
        : null;
      const sel = clipped && clipped[0] < clipped[1] ? clipped : null;
      // 光标列随块平移：停在字符上落覆盖块；停在行尾挂 endBlock 行
      //（cursorCol ≥ 块长时 promptLineSegments 追加行尾反色空格）
      const cCol =
        showCursor && r.line === p.curLine && p.curCol >= r.start && (p.curCol < r.end || r.endBlock)
          ? p.curCol - r.start
          : null;
      // 无光标且无选区：纯文本行
      if (cCol === null && !sel) return <text>{prefix + chars.slice(r.start, r.end).join("")}</text>;
      return (
        <text>
          {prefix}
          {promptLineSegments(chars.slice(r.start, r.end), cCol, sel).map((seg, k) =>
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
