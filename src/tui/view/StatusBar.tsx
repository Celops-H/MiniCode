/**
 * 状态行（底部固定一行）：模型 · 会话标题 · 模式[default/plan mode/auto mode] · 运行状态 · 操作提示。
 * 会话位显示标题（随 /rename 同步；长标题按列宽截断到 20 列），id 完整值在 /session 面板可见。
 * 观感对齐 opencode footer 一行内分布；窄屏右侧溢出被截（模型名在左盒最前，优先保留）。
 */
import type { JSX } from "@opentui/solid";
import { theme } from "./theme.js";
import { permissionModeLabel } from "../state.js";
import { fitWidth } from "./fit.js";
import type { PermissionMode } from "../../permission/index.js";

export interface StatusBarProps {
  model: string;
  /** 会话标题（/rename 后同步更新；空显示「新会话」） */
  title: string;
  status: "idle" | "running";
  permissionMode?: PermissionMode;
}

export function StatusBar(props: StatusBarProps): JSX.Element {
  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} paddingX={1} flexShrink={0}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={theme.modelColor}>{props.model}</text>
        {/* 会话标题：最长 20 列截断（CJK 列宽），避免长标题把模式 chip/右侧提示顶出 */}
        <text fg={theme.textMuted}>
          · 会话 {fitWidth(props.title || "新会话", 20)}
        </text>
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