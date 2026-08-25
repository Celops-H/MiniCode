/**
 * 状态行（底部固定一行）：模型 · 会话id · 模式[default/plan mode/auto mode] · 运行状态 · 操作提示。
 * 观感对齐 opencode footer 一行内分布；窄屏右侧溢出被截（模型名与模式 chip 优先保留，flexShrink:0）。
 */
import type { JSX } from "@opentui/solid";
import { theme } from "./theme.js";
import { permissionModeLabel } from "../state.js";
import type { PermissionMode } from "../../permission/index.js";

export interface StatusBarProps {
  model: string;
  sessionId: string;
  status: "idle" | "running";
  permissionMode?: PermissionMode;
}

export function StatusBar(props: StatusBarProps): JSX.Element {
  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} paddingX={1} paddingTop={1} flexShrink={0}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={theme.text}>{props.model}</text>
        <text fg={theme.textMuted}>· 会话 {props.sessionId.slice(-6)}</text>
        {props.permissionMode ? (
          <text fg={theme.foregroundAccent}>· 模式[{permissionModeLabel(props.permissionMode)}]</text>
        ) : null}
      </box>
      <text fg={theme.textMuted} flexShrink={0}>
        {props.status === "running" ? (
          <span style={{ fg: theme.warning }}>▶ 运行中（Esc 打断 · 连按两次 Esc 退出）</span>
        ) : (
          <span>
            <span style={{ fg: theme.success }}>● 空闲</span>
            <span style={{ fg: theme.textMuted }}> · ↑↓ 历史 · Ctrl+J 换行</span>
          </span>
        )}
      </text>
    </box>
  );
}