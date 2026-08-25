/**
 * 嵌入弹块（R4）：权限确认 / 会话切换面板。
 * state.modal 由 loop 的 approver（权限请求）与 /session 命令写入；组件只读呈现。
 * 键位：权限三决策 1/a/d 或 ←→ 选择 Enter 确认 Esc 拒绝；会话列表 ↑↓ 选择 Enter 切换 Esc 取消。
 */
import { For } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { ModalState } from "../state.js";
import { PERMISSION_OPTIONS } from "../state.js";
import { theme } from "./theme.js";

/** 权限确认：工具名 + 参数原文 + 三决策 + 键位提示 */
function PermissionModal(props: { modal: Extract<ModalState, { kind: "permission" }> }): JSX.Element {
  const b = props.modal;
  return (
    <box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
      <text fg={theme.warning}>⚠ 权限确认</text>
      <text>
        工具 {b.toolName}
        {b.content ? ` · ${b.content}` : ""}
      </text>
      <text fg={theme.textMuted}>{b.argsText}</text>
      <box flexDirection="row" gap={1}>
        <For each={PERMISSION_OPTIONS}>
          {(opt, i) => (
            <text fg={i() === b.selected ? theme.foregroundAccent : theme.text}>
              [{opt.key}] {opt.label}
              {i() === b.selected ? " ◀" : ""}
            </text>
          )}
        </For>
      </box>
      <text fg={theme.textMuted}>1/a/d 或 ←→ 选择 · Enter 确认 · Esc 拒绝</text>
    </box>
  );
}

/** 会话切换面板：最近会话列表 + 新建入口，选中高亮 */
function SessionModal(props: { modal: Extract<ModalState, { kind: "session" }> }): JSX.Element {
  const b = props.modal;
  return (
    <box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
      <text fg={theme.foregroundAccent}>切换会话</text>
      <For each={b.sessions}>
        {(s, i) => (
          <text fg={i() === b.selected ? theme.foregroundAccent : theme.text}>
            {i() === b.selected ? "▸ " : "  "}
            {s.id.slice(-6)} · {s.model}
          </text>
        )}
      </For>
      <text fg={b.selected === b.sessions.length ? theme.foregroundAccent : theme.textMuted}>
        {b.selected === b.sessions.length ? "▸ " : "  "}
        ── 新建会话 ──
      </text>
      <text fg={theme.textMuted}>↑↓ 选择 · Enter 切换/新建 · Esc 取消</text>
    </box>
  );
}

export function ModalView(props: { modal: ModalState }): JSX.Element {
  if (props.modal.kind === "permission") return <PermissionModal modal={props.modal} />;
  return <SessionModal modal={props.modal} />;
}