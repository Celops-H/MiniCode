/**
 * 消息流（R1 简化）：把 state.blocks 渲染在消息区。
 * 每一类块先一行概览（用户/助手/工具/子agent 活动），R2 按 opencode 观感展开完整卡片。
 * 注意：块内容以三元内联（不用「函数返回 JSX」模式）——opentui reconciler 对函数返回的元素
 * 曾触发空文本头节点（Orphan text），改为直接内联表达式后正常。
 */
import { For } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { BlockView } from "../state.js";
import { theme } from "./theme.js";

export function Messages(props: { blocks: BlockView[] }): JSX.Element {
  return (
    <scrollbox flexGrow={1} paddingX={1}>
      <For each={props.blocks}>
        {(b) => (
          <box flexShrink={0} paddingY={0}>
            {b.kind === "message" ? (
              <text>{b.text || "（无文本）"}</text>
            ) : b.kind === "tool" ? (
              <text fg={theme.textMuted}>
                {b.name ?? "tool"} · {b.status}
              </text>
            ) : (
              <text fg={theme.textMuted}>子 agent [{b.path}] · {b.event}</text>
            )}
          </box>
        )}
      </For>
      {props.blocks.length === 0 ? (
        <box flexShrink={0}>
          <text fg={theme.textMuted}>开始对话吧——输入消息后回车。</text>
        </box>
      ) : null}
    </scrollbox>
  );
}