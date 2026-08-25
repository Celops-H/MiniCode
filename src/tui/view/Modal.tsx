/**
 * 嵌入弹块（R4 + 收尾打磨批 ⑪）：权限确认 / 会话切换面板。
 * state.modal 由 loop 的 approver（权限请求）与 /session 命令写入；组件只读呈现。
 * 框线风格与消息区工具卡一体：rounded 边框 + 边框内标题，分区（标题/参数/选项/键位提示）。
 * 键位：权限三决策 1/a/d 或 ←→ 选择 Enter 确认 Esc 拒绝；会话列表 ↑↓ 选择 Enter 切换 Esc 取消。
 */
import { For } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { ModalState } from "../state.js";
import { PERMISSION_OPTIONS } from "../state.js";
import { theme } from "./theme.js";

/** 权限确认：边框内标题 + 工具/参数 + 三决策 + 键位提示（选中项高亮 chip） */
function PermissionModal(props: { modal: Extract<ModalState, { kind: "permission" }> }): JSX.Element {
  const b = props.modal;
  return (
    <box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
      <box border={true} borderStyle="rounded" borderColor={theme.warning} flexDirection="column" flexShrink={0} backgroundColor={theme.backgroundPanel}
        title="⚠ 权限确认" titleColor={theme.warning}>
        <text paddingX={1} paddingY={1}>
          工具 <span style={{ fg: theme.foregroundAccent }}>{b.toolName}</span>
          {b.content ? ` · ${b.content}` : ""}
        </text>
        {b.argsText ? (
          <text fg={theme.textMuted} paddingX={1}>
            参数 {b.argsText}
          </text>
        ) : null}
        <box flexDirection="row" gap={1} paddingX={1} paddingTop={1}>
          <For each={PERMISSION_OPTIONS}>
            {(opt, i) =>
              i() === b.selected ? (
                <text>
                  <span style={{ bg: theme.foregroundAccent, fg: theme.text }}>
                    [{opt.key}] {opt.label} ◀
                  </span>
                </text>
              ) : (
                <text fg={theme.textMuted}>[{opt.key}] {opt.label}</text>
              )
            }
          </For>
        </box>
        <text fg={theme.textMuted} paddingX={1} paddingY={1}>
          1/a/d 或 ←→ 选择 · Enter 确认 · Esc 拒绝
        </text>
      </box>
    </box>
  );
}

/** 会话切换面板：边框内标题 + 最近会话列表 + 新建入口（选中高亮），键位提示 */
function SessionModal(props: { modal: Extract<ModalState, { kind: "session" }> }): JSX.Element {
  const b = props.modal;
  return (
    <box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
      <box border={true} borderStyle="rounded" borderColor={theme.foregroundAccent} flexDirection="column" flexShrink={0} backgroundColor={theme.backgroundPanel}
        title="切换会话" titleColor={theme.foregroundAccent}>
        <For each={b.sessions}>
          {(s, i) => (
            <text paddingX={1} paddingTop={1}
              fg={i() === b.selected ? theme.foregroundAccent : theme.text}>
              {i() === b.selected ? "▸ " : "  "}
              {s.id.slice(-6)} · {s.model}
            </text>
          )}
        </For>
        <text paddingX={1} paddingTop={1}
          fg={b.selected === b.sessions.length ? theme.foregroundAccent : theme.textMuted}>
          {b.selected === b.sessions.length ? "▸ " : "  "}
          ── 新建会话 ──
        </text>
        <text fg={theme.textMuted} paddingX={1} paddingY={1}>
          ↑↓ 选择 · Enter 切换/新建 · Esc 取消
        </text>
      </box>
    </box>
  );
}

export function ModalView(props: { modal: ModalState }): JSX.Element {
  if (props.modal.kind === "permission") return <PermissionModal modal={props.modal} />;
  return <SessionModal modal={props.modal} />;
}