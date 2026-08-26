/**
 * 嵌入弹块（R4 + 收尾打磨批 ⑪）：权限确认 / 会话切换面板。
 * state.modal 由 loop 的 approver（权限请求）与 /session 命令写入；组件只读呈现。
 * 框线风格与消息区工具卡一体：rounded 边框 + 边框内标题，分区（标题/参数/选项/键位提示）。
 * 键位：权限三决策 1/2/3 或 ←→ 选择 Enter 确认 Esc 拒绝；会话列表 ↑↓ 选择 Enter 切换 Esc 取消。
 * 注意：选项行/光标这类「For 里随标量变化」的渲染不能用 <For>+条件（opentui reconciler 下不随
 * 非 each 依赖的标量刷新），改用 createMemo 直接读 selected 重算——高亮随 ←→ 移动。
 */
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import type { ModalState, ConnectPickModalState, ConnectKeyModalState } from "../state.js";
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

/** 会话切换面板：等宽卡片居中弹层（非全屏铺满）+ 边框内标题 + 最近会话列表 + 新建入口，键位提示。
 *  列表行高与窗口计算一致（每行 1 行、模型名按卡宽截断防折行），卡内总高 ≤ 可用高度，
 *  选中项随 ↑↓ 窗口滚动入视野、越界贴边 clamp——列表再长也不滑出视口、下边框始终可见。 */
function SessionModal(props: { modal: Extract<ModalState, { kind: "session" }> }): JSX.Element {
  const b = props.modal;
  const dims = useTerminalDimensions();
  // 等宽卡宽：64 内定宽、左右留白居中；极窄终端保底 20（负宽会破坏布局）
  const cardWidth = Math.max(20, Math.min(64, (dims().width ?? 80) - 4));
  // 列表行：窗口渲染（memo 读 selected/dims 重算）。卡内固定开销（外边距 2 + 边框标题 1 + 新建 1 + 提示 3 + 底框 1）=8 行；
  // 终端高减 9 行给卡下固定内容（输入框 5 + 状态行 2 + agent/通知 2）占位，剩余高度按 1 行/条分配会话可见条数，
  // 选中项居中滚动、越界贴边——卡与底部状态行都不被顶出视口。
  // 模型名预算：卡宽 - 边框 2 - 行 paddingX 2 - 行前缀（▸ 6位id · ）11 ≈ 15；超出截断加省略号防折行破 1 行/条假设。
  const modelMax = cardWidth - 15;
  const fitModel = (m: string): string => (Array.from(m).length > modelMax ? `${Array.from(m).slice(0, modelMax).join("")}…` : m);
  const rows = createMemo(() => {
    const total = b.sessions.length;
    const avail = Math.max(10, (dims().height ?? 20) - 9);
    const sessRows = Math.max(1, Math.min(total, avail - 8));
    const start = Math.max(0, Math.min(b.selected - Math.floor((sessRows - 1) / 2), total - sessRows));
    const visible = b.sessions.slice(start, start + sessRows);
    const items = visible.map((s, i) => {
      const sel = start + i === b.selected;
      const model = fitModel(s.model);
      return sel ? (
        <text paddingX={1} fg={theme.foregroundAccent}>
          ▸ {s.id.slice(-6)} · {model}
        </text>
      ) : (
        <text paddingX={1} fg={theme.text}>
          {"  "}
          {s.id.slice(-6)} · {model}
        </text>
      );
    });
    const newSel = b.selected === total;
    items.push(
      newSel ? (
        <text paddingX={1} fg={theme.foregroundAccent}>
          ▸ ── 新建会话 ──
        </text>
      ) : (
        <text paddingX={1} fg={theme.textMuted}>
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
    <box flexDirection="row" justifyContent="center" paddingY={1} flexShrink={0}>
      <box width={cardWidth} border={true} borderStyle="rounded" borderColor={theme.foregroundAccent} flexDirection="column" flexShrink={0} backgroundColor={theme.backgroundPanel}
        title="切换会话" titleColor={theme.foregroundAccent}>
        {rows()}
      </box>
    </box>
  );
}

/** /connect 两阶段弹窗（选供应商 → 输 API Key）：两阶段共用同一组件，内容由 createMemo 按 modal 数据驱动。
 *  不能拆成两个组件靠 ModalView 分支切换——@opentui reconciler 下组件级分支随 kind 标量变化不刷新
 *  （真机根因：Enter 选供应商后界面停留列表、行为已切到 key 输入态）。createMemo 返回数据节点（text）会刷新。 */
function ConnectFlowModal(props: { modal: ConnectPickModalState | ConnectKeyModalState }): JSX.Element {
  const b = props.modal;
  const dims = useTerminalDimensions();
  // key 输入光标（闪烁）：key 在弹窗内输入，光标块指示实际输入位置（模态时底部输入框光标已隐藏）
  const [cursorOn, setCursorOn] = createSignal(true);
  onMount(() => {
    const timer = setInterval(() => setCursorOn((c) => !c), 500);
    onCleanup(() => clearInterval(timer));
  });
  const rows = createMemo(() => {
    // key 输入阶段
    if (b.kind === "connect-key") {
      const display = b.key ? (b.key.length <= 24 ? b.key : `…${b.key.slice(-12)}`) : "（未输入）";
      return [
        <text paddingX={1} paddingY={1} fg={theme.success}>
          输入 API Key · {b.providerName}
        </text>,
        <text paddingX={1}>
          默认模型 {b.defaultModel} · {b.apiKeyEnv}：
        </text>,
        <text paddingX={2} fg={theme.foregroundAccent}>
          {display}
          {/* 反色块光标：亮/灭闪烁，指示 key 输入位置（未输入时光标在行首） */}
          <span style={{ bg: cursorOn() ? theme.foregroundAccent : theme.backgroundRaised, fg: theme.background }}>
            {" "}
          </span>
        </text>,
        <text fg={theme.textMuted} paddingX={1} paddingY={1}>
          Enter 确认连接 · Backspace 删除 · Esc 取消
        </text>,
      ];
    }
    // 选供应商阶段：窗口渲染防超页，选中高亮随导航移动
    const total = b.providers.length;
    const avail = dims().height ?? 20;
    const visible = Math.max(1, Math.min(total, avail - 6));
    const start = Math.max(0, Math.min(b.selected - Math.floor((visible - 1) / 2), total - visible));
    const items = [
      <text paddingX={1} paddingY={1} fg={theme.success}>
        连接供应商
      </text>,
      ...b.providers.slice(start, start + visible).map((p, i) =>
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
      ),
    ];
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
      <box border={true} borderStyle="rounded" borderColor={theme.success} flexDirection="column" flexShrink={0} backgroundColor={theme.backgroundPanel}>
        {rows()}
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
  // 直接 if 分支返回，不包 createMemo：createMemo 返回「组件元素」在 @opentui 下不刷新
  //（真机 connect 选供应商后界面卡在列表的根因）。connect 两阶段统一 ConnectFlowModal——
  // 组件类型稳定，阶段切换由 ConnectFlowModal 内部 rows createMemo 数据驱动（读 b.kind）；
  // 其余模态每次从「无 modal」挂载、kind 不切换，直接分支即可。
  if (props.modal.kind === "permission") return <PermissionModal modal={props.modal} />;
  if (props.modal.kind === "connect" || props.modal.kind === "connect-key")
    return <ConnectFlowModal modal={props.modal} />;
  if (props.modal.kind === "model") return <ModelModal modal={props.modal} />;
  return <SessionModal modal={props.modal} />;
}