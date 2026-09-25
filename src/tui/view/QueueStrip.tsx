/**
 * 排队条（E52/E72）：在途操作期间入队的消息与命令，展示在输入框上方——
 * 区别于消息区的普通消息块（不混排、不受执行中块影响），逐条列出并提示取消键位。
 * Ctrl+P 取消最后一个排队项（恢复到输入框供编辑重发）。
 */
import { For, Show } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { QueuedItem } from "../state.js";
import { theme } from "./theme.js";

/** 单条预览长度上限（字符）：排队条只求可辨识，长文本截断 */
const PREVIEW_MAX_CHARS = 60;

/** 预览文本：取首行、超长截断 */
function preview(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  const chars = Array.from(firstLine);
  return chars.length > PREVIEW_MAX_CHARS ? `${chars.slice(0, PREVIEW_MAX_CHARS).join("")}…` : firstLine;
}

/** 排队条展示条数上限：超出折叠为「…共 n 项」，防长队列持续压缩消息区可视高度 */
const MAX_VISIBLE_ITEMS = 5;

export function QueueStrip(props: { items: QueuedItem[] }): JSX.Element {
  const visible = () => props.items.slice(0, MAX_VISIBLE_ITEMS);
  const overflow = () => props.items.length - visible().length;
  return (
    <box flexShrink={0} flexDirection="column" paddingX={1}>
      <For each={visible()}>
        {(item, index) => (
          <text fg={theme.textMuted}>
            {`↳ 排队 ${index() + 1}（${item.kind === "command" ? "命令" : "消息"}）：${preview(item.text)}`}
          </text>
        )}
      </For>
      <Show when={overflow() > 0}>
        <text fg={theme.textMuted}>{`↳ …共 ${props.items.length} 项`}</text>
      </Show>
      <text fg={theme.textMuted}>Ctrl+P 取消最后一个排队项</text>
    </box>
  );
}
