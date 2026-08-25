/**
 * 状态行（底部固定一行）：模型 · 会话id · 运行状态 · 操作提示。
 * 观感对齐 opencode footer 一行内分布；字段超宽时左侧被截（模型名优先保留）。
 */
import type { JSX } from "@opentui/solid";
import { theme } from "./theme.js";

export interface StatusBarProps {
  model: string;
  sessionId: string;
  status: "idle" | "running";
}

export function StatusBar(props: StatusBarProps): JSX.Element {
  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} paddingX={1} paddingTop={1} flexShrink={0}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={theme.text}>{props.model}</text>
        <text fg={theme.textMuted}>· 会话 {props.sessionId.slice(-6)}</text>
      </box>
      <text fg={theme.textMuted} flexShrink={0}>
        {props.status === "running" ? (
          <span style={{ fg: theme.warning }}>▶ 运行中（Ctrl+C 打断当前轮）</span>
        ) : (
          <span>
            <span style={{ fg: theme.success }}>● 空闲</span>
            <span style={{ fg: theme.textMuted }}> · ↑↓ 历史 · S+Enter 换行</span>
          </span>
        )}
      </text>
    </box>
  );
}