/**
 * 输入框视图（R1 简化）：渲染多行编辑内容与光标（光标以反色块标记）。
 * 编辑逻辑全在 reducer（input/backspace/cursor/history 动作），本组件只读 prompt 状态呈现。
 * 中文宽度换算与 IME 拼合在 R3 输入框完整化时处理。
 */
import { For } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { PromptState } from "../state.js";
import { theme } from "./theme.js";

export function PromptView(props: { prompt: PromptState }): JSX.Element {
  return (
    <box flexDirection="column" flexShrink={0} paddingX={1}>
      <For each={props.prompt.lines}>
        {(line, i) => {
          if (i() !== props.prompt.curLine) return <text>{line}</text>;
          const chars = Array.from(line);
          const before = chars.slice(0, props.prompt.curCol).join("");
          const after = chars.slice(props.prompt.curCol).join("");
          return (
            <text>
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