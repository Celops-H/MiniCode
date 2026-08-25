/**
 * 输入框视图（R3a）：多行编辑 + 光标（反色块）+ slash 候选列表。
 * 编辑逻辑全在 reducer（input/backspace/cursor/history/newline/send 动作），本组件只读 prompt 呈现。
 * 光标反色块紧跟光标前文本：opentui 布局引擎按展示宽度排版（CJK 宽字符自动占 2 格），无需手动换算。
 * 候选列表：输入以 / 开头时按 query 匹配命令展示，选中项高亮（↑↓ 选择、Tab 补全由 reducer 处理）。
 */
import { For } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { PromptState, SlashCandidate } from "../state.js";
import { theme } from "./theme.js";

/** slash 候选列表：query 与匹配项，选中项高亮 */
function CandidateList(props: { candidate: SlashCandidate }): JSX.Element {
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={props.candidate.items}>
        {(item, i) => (
          <box flexShrink={0}>
            <text fg={i() === props.candidate.selected ? theme.foregroundAccent : theme.textMuted}>
              {i() === props.candidate.selected ? "▸ " : "  "}
              {item}
            </text>
          </box>
        )}
      </For>
      <text fg={theme.textMuted}>Tab 补全 · ↑↓ 选择 · Esc 收起</text>
    </box>
  );
}

export function PromptView(props: { prompt: PromptState; candidate?: SlashCandidate }): JSX.Element {
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
      paddingTop={1}
      border={["top"]}
      borderColor={theme.backgroundPanel}
    >
      {props.candidate ? <CandidateList candidate={props.candidate} /> : null}
      <For each={props.prompt.lines}>
        {(line, i) => {
          const prefix = i() === 0 ? "❯ " : "  ";
          if (i() !== props.prompt.curLine) return <text>{prefix + line}</text>;
          const chars = Array.from(line);
          const before = chars.slice(0, props.prompt.curCol).join("");
          const after = chars.slice(props.prompt.curCol).join("");
          return (
            <text>
              {prefix}
              {before}
              <span style={{ bg: theme.textMuted, fg: theme.text }}> </span>
              {after}
            </text>
          );
        }}
      </For>
    </box>
  );
}