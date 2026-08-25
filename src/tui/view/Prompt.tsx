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
import type { PromptState, SlashCandidate } from "../state.js";
import { theme } from "./theme.js";

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

export function PromptView(props: { prompt: PromptState; candidate?: SlashCandidate; blink?: boolean }): JSX.Element {
  // 光标闪烁：500ms 切换一次「亮/灭」色（反色块由强调色 ⇄ 低对比）；测试可传 blink=false 关掉
  const [cursorOn, setCursorOn] = createSignal(true);
  onMount(() => {
    if (props.blink === false) return;
    const timer = setInterval(() => setCursorOn((c) => !c), 500);
    onCleanup(() => clearInterval(timer));
  });

  // 行列表：读整个 prompt（lines/curLine/curCol），任何变化整体重算——光标位置必跟上
  const rows = createMemo(() => {
    const p = props.prompt;
    return p.lines.map((line, i) => {
      const prefix = i === 0 ? "❯ " : "  ";
      if (i !== p.curLine) return <text>{prefix + line}</text>;
      const chars = Array.from(line);
      const before = chars.slice(0, p.curCol).join("");
      const after = chars.slice(p.curCol).join("");
      return (
        <text>
          {prefix}
          {before}
          {/* 反色块光标：亮=强调色底，灭=低对比底（闪烁），位置=实际编辑列 */}
          <span style={{ bg: cursorOn() ? theme.foregroundAccent : theme.backgroundRaised, fg: theme.background }}>
            {" "}
          </span>
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
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={theme.backgroundPanel}
      border={["top"]}
      borderColor={theme.border}
    >
      {props.candidate ? <CandidateList candidate={props.candidate} /> : null}
      {rows()}
    </box>
  );
}