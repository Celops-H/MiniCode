/**
 * 嵌入弹块（R4 + 收尾打磨批 ⑪）：权限确认 / 会话切换面板。
 * state.modal 由 loop 的 approver（权限请求）与 /session 命令写入；组件只读呈现。
 * 框线风格与消息区工具卡一体：rounded 边框 + 边框内标题，分区（标题/参数/选项/键位提示）。
 * 键位：权限三决策 1/2/3 或 ←→ 选择 Enter 确认 Esc 拒绝；会话列表 ↑↓ 选择 Enter 切换 Esc 取消。
 * 注意：选项行/光标这类「For 里随标量变化」的渲染不能用 <For>+条件（opentui reconciler 下不随
 * 非 each 依赖的标量刷新），改用 createMemo 直接读 selected 重算——高亮随 ←→ 移动。
 */
import { createMemo } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import type { ModalState } from "../state.js";
import { PERMISSION_OPTIONS, thinkingLevelLabel } from "../state.js";
import { theme } from "./theme.js";

/** 权限确认：边框内标题 + 工具/参数 + 三决策 + 键位提示（选中项高亮 chip，随 ←→ 移动） */
function PermissionModal(props: { modal: Extract<ModalState, { kind: "permission" }> }): JSX.Element {
  const b = props.modal;
  // 选项行：memo 读 b.selected 重算（For+条件在此渲染器下不刷新标量，见文件头注释）
  const optionLine = createMemo(() =>
    PERMISSION_OPTIONS.map((opt, i) => {
      const sel = b.selected === i;
      return sel ? (
        <span style={{ bg: theme.foregroundAccent, fg: theme.text }}>
          [{opt.key}] {opt.label} ◀
        </span>
      ) : (
        <span style={{ fg: theme.textMuted }}> [{opt.key}] {opt.label} </span>
      );
    }),
  );
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
        <box flexDirection="row" paddingX={1} paddingTop={1}>
          <text>{optionLine()}</text>
        </box>
        <text fg={theme.textMuted} paddingX={1} paddingY={1}>
          1/2/3 或 ←→ 选择 · Enter 确认 · Esc 拒绝
        </text>
      </box>
    </box>
  );
}

/** 会话切换面板：边框内标题 + 最近会话列表 + 新建入口（选中高亮随 ↑↓ 移动），键位提示。
 *  会话多于可视高度时按窗口渲染（选中项尽量居中，越界贴边），防列表溢出屏幕。 */
function SessionModal(props: { modal: Extract<ModalState, { kind: "session" }> }): JSX.Element {
  const b = props.modal;
  const dims = useTerminalDimensions();
  // 列表行：窗口渲染（memo 读 selected/dims 重算）。标题框+提示约 6 行，会话条按剩余高度截断
  const rows = createMemo(() => {
    const total = b.sessions.length;
    const avail = dims().height ?? 20;
    const sessRows = Math.max(1, Math.min(total, avail - 7));
    const start = Math.max(0, Math.min(b.selected - Math.floor((sessRows - 1) / 2), total - sessRows));
    const visible = b.sessions.slice(start, start + sessRows);
    const items = visible.map((s, i) => {
      const sel = start + i === b.selected;
      return sel ? (
        <text paddingX={1} paddingTop={1} fg={theme.foregroundAccent}>
          ▸ {s.id.slice(-6)} · {s.model}
        </text>
      ) : (
        <text paddingX={1} paddingTop={1} fg={theme.text}>
          {"  "}
          {s.id.slice(-6)} · {s.model}
        </text>
      );
    });
    const newSel = b.selected === total;
    items.push(
      newSel ? (
        <text paddingX={1} paddingTop={1} fg={theme.foregroundAccent}>
          ▸ ── 新建会话 ──
        </text>
      ) : (
        <text paddingX={1} paddingTop={1} fg={theme.textMuted}>
          {"  "}── 新建会话 ──
        </text>
      ),
    );
    const overflow = total > sessRows ? `（${start + 1}-${Math.min(start + sessRows, total)}/${total}）` : "";
    items.push(
      <text fg={theme.textMuted} paddingX={1} paddingY={1}>
        ↑↓ 选择 · Enter 切换/新建 · Esc 取消{overflow}
      </text>,
    );
    return items;
  });
  return (
    <box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
      <box border={true} borderStyle="rounded" borderColor={theme.foregroundAccent} flexDirection="column" flexShrink={0} backgroundColor={theme.backgroundPanel}
        title="切换会话" titleColor={theme.foregroundAccent}>
        {rows()}
      </box>
    </box>
  );
}

/** /connect 供应商选择：边框内标题 + 厂商列表（选中高亮随导航移动）+ 键位提示 */
function ConnectModal(props: { modal: Extract<ModalState, { kind: "connect" }> }): JSX.Element {
  const b = props.modal;
  const dims = useTerminalDimensions();
  const rows = createMemo(() => {
    const total = b.providers.length;
    const avail = dims().height ?? 20;
    const visible = Math.max(1, Math.min(total, avail - 6));
    const start = Math.max(0, Math.min(b.selected - Math.floor((visible - 1) / 2), total - visible));
    const items = b.providers.slice(start, start + visible).map((p, i) =>
      start + i === b.selected ? (
        <text paddingX={1} paddingTop={1} fg={theme.foregroundAccent}>
          ▸ {p.name}（{p.defaultModel}）
        </text>
      ) : (
        <text paddingX={1} paddingTop={1} fg={theme.text}>
          {"  "}
          {p.name}（{p.defaultModel}）
        </text>
      ),
    );
    const overflow = total > visible ? `（${start + 1}-${Math.min(start + visible, total)}/${total}）` : "";
    items.push(
      <text fg={theme.textMuted} paddingX={1} paddingY={1}>
        ↑↓/←→ 选择 · Enter 输入 API Key · Esc 取消{overflow}
      </text>,
    );
    return items;
  });
  return (
    <box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
      <box border={true} borderStyle="rounded" borderColor={theme.success} flexDirection="column" flexShrink={0} backgroundColor={theme.backgroundPanel}
        title="连接供应商" titleColor={theme.success}>
        {rows()}
      </box>
    </box>
  );
}

/** /connect key 输入弹窗：供应商名 + API Key 输入区（弹窗内输 key，明文显示便于核对）+ 键位提示 */
function ConnectKeyModal(props: { modal: Extract<ModalState, { kind: "connect-key" }> }): JSX.Element {
  const b = props.modal;
  return (
    <box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
      <box border={true} borderStyle="rounded" borderColor={theme.success} flexDirection="column" flexShrink={0} backgroundColor={theme.backgroundPanel}
        title={`输入 API Key · ${b.providerName}`} titleColor={theme.success}>
        <text paddingX={1} paddingY={1}>
          连接供应商 {b.providerName}，默认模型 {b.defaultModel}。输入 {b.apiKeyEnv}：
        </text>
        {/* key 展示：≤24 字符全文显示，超长截断保留末 12 位（通常是对照项），防整屏换行溢出 */}
        <text paddingX={2} fg={theme.foregroundAccent}>
          {b.key ? (b.key.length <= 24 ? b.key : `…${b.key.slice(-12)}`) : "（未输入）"}
        </text>
        <text fg={theme.textMuted} paddingX={1} paddingY={1}>
          Enter 确认连接 · Backspace 删除 · Esc 取消
        </text>
      </box>
    </box>
  );
}

/** /model 模型选择：模型列表（↑↓ 选）+ 思考等级行（←→ 调）+ 键位提示；窗口渲染防超页 */
function ModelModal(props: { modal: Extract<ModalState, { kind: "model" }> }): JSX.Element {
  const b = props.modal;
  const dims = useTerminalDimensions();
  const rows = createMemo(() => {
    const total = b.models.length;
    const avail = dims().height ?? 20;
    const visible = Math.max(1, Math.min(total, avail - 7));
    const start = Math.max(0, Math.min(b.selected - Math.floor((visible - 1) / 2), total - visible));
    const items = b.models.slice(start, start + visible).map((m, i) =>
      start + i === b.selected ? (
        <text paddingX={1} paddingTop={1} fg={theme.foregroundAccent}>
          ▸ {m.id}
        </text>
      ) : (
        <text paddingX={1} paddingTop={1} fg={theme.text}>
          {"  "}
          {m.id}
        </text>
      ),
    );
    const overflow = total > visible ? `（${start + 1}-${Math.min(start + visible, total)}/${total}）` : "";
    items.push(
      <text paddingX={1} paddingTop={1} fg={theme.textMuted}>
        思考等级：{thinkingLevelLabel(b.thinkingLevel)}（←→ 调整）
      </text>,
    );
    items.push(
      <text fg={theme.textMuted} paddingX={1} paddingY={1}>
        ↑↓ 选模型 · ←→ 思考等级 · Enter 应用 · Esc 取消{overflow}
      </text>,
    );
    return items;
  });
  return (
    <box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
      <box border={true} borderStyle="rounded" borderColor={theme.foregroundAccent} flexDirection="column" flexShrink={0} backgroundColor={theme.backgroundPanel}
        title="选择模型" titleColor={theme.foregroundAccent}>
        {rows()}
      </box>
    </box>
  );
}

export function ModalView(props: { modal: ModalState }): JSX.Element {
  if (props.modal.kind === "permission") return <PermissionModal modal={props.modal} />;
  if (props.modal.kind === "connect") return <ConnectModal modal={props.modal} />;
  if (props.modal.kind === "connect-key") return <ConnectKeyModal modal={props.modal} />;
  if (props.modal.kind === "model") return <ModelModal modal={props.modal} />;
  return <SessionModal modal={props.modal} />;
}