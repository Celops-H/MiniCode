/**
 * TUI 根视图（R0 最小版）：验证 opentui 渲染链就位。后续块在此扩展三区骨架与消息流。
 */
import type { JSX } from "@opentui/solid";

export function App(): JSX.Element {
  return (
    <box flexDirection="column" flexGrow={1} padding={1}>
      <text>MiniCode TUI — opentui 渲染链就位</text>
    </box>
  );
}