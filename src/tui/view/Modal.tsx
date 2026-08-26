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
import { colWidth, fitWidth, padCols, relativeTime, formatBytes } from "./fit.js";

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

/** 会话切换面板（P4-3 全屏化）：完全全屏页面（消息/输入/状态行隐藏，App 层条件渲染），
 *  左对齐布局、每会话两行——主行「哈希 标题 模型」三列各自对齐（列宽截断不顶开模型），
 *  副行「最近活跃 xx ago · 消息文件大小 N KB」；条目间空一行加大间距；
 *  当前活跃会话不在列表（loop 已过滤）；选中行操作态进入/删除 ←→ 切换（P4-2）。
 *  列表超视口窗口渲染：选中项滚动入视野、越界贴边 clamp。 */
function SessionModal(props: { modal: Extract<ModalState, { kind: "session" }> }): JSX.Element {
  const b = props.modal;
  const dims = useTerminalDimensions();
  // 列表区可用高度：标题 2 + 提示 3 + 底部余量 1；选中项居中滚动、越界贴边
  const rows = createMemo(() => {
    const total = b.sessions.length;
    const avail = Math.max(6, (dims().height ?? 20) - 7);
    // 每条占 2 行（主+副）+ 条目间 1 行空：可见条数按实际总行数预算
    const perRow = 3; // 主行 + 副行 + 间距
    const sessRows = Math.max(1, Math.min(total, Math.floor(avail / perRow)));
    const start = Math.max(0, Math.min(b.selected - Math.floor((sessRows - 1) / 2), total - sessRows));
    const visible = b.sessions.slice(start, start + sessRows);
    // 三列宽度：终端宽内分配——模型列随内容自适应（最长不超 26），标题吃中间剩余预算
    const termW = Math.max(30, (dims().width ?? 80) - 4);
    const idCols = 6; // 哈希显示固定 6 位
    const PREFIX_COLS = 2 + idCols + 3; // ▸/空格(2) + id + 「 · 」(3)
    const modelCol = Math.min(26, Math.max(8, ...visible.map((s) => colWidth(s.model) + 2)));
    const titleBudget = Math.max(2, termW - modelCol - PREFIX_COLS - 10); // 预留操作态 10 列
    const items: JSX.Element[] = [];
    visible.forEach((s, i) => {
      const sel = start + i === b.selected;
      const idCell = s.id.slice(-idCols);
      const title = fitWidth(s.title || "新会话", titleBudget);
      const actionTag = sel ? (b.action === "delete" ? "  ✕ 删除" : "  ◀ 进入") : "";
      // 主行：哈希 / 标题 / 模型三列各自对齐（padCols 补齐定宽列，长内容截断不顶开后续列）
      items.push(
        <text paddingLeft={1} paddingTop={i === 0 ? 0 : 1} fg={sel ? (b.action === "delete" ? theme.error : theme.foregroundAccent) : theme.text}>
          {`${sel ? "▸ " : "  "}${padCols(idCell, idCols)} · ${padCols(title, titleBudget)}${fitWidth(s.model, modelCol)}${actionTag}`}
        </text>,
      );
      items.push(
        <text paddingLeft={3} fg={theme.textMuted}>
          {`${relativeTime(s.updatedAt)} · ${formatBytes(s.sizeBytes)}`}
        </text>,
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
        ↑↓ 选择 · ←→ 进入/删除 · Enter 确定 · Esc 返回{overflow}
      </text>,
    );
    return items;
  });
  return (
    <box flexDirection="column" flexGrow={1} flexShrink={0} backgroundColor={theme.background}>
      <box flexDirection="row">
        <text fg={theme.foregroundAccent} paddingLeft={1}>
          会话列表
        </text>
        <text fg={theme.textMuted}>（{b.sessions.length} 个其它会话，Esc 返回当前会话）</text>
      </box>
      {rows()}
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
          {/* 竖线光标（P4-5）：key 输入位置细竖线指示，明灭闪烁 */}
          <span style={{ fg: cursorOn() ? theme.foregroundAccent : theme.background }}>│</span>
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

/** /model 模型选择：按厂商分组（● 厂商名 组头 + 缩进模型行，组头不可选中、模型行与厂商名不对齐）
 *  + 思考等级行（←→ 调）+ 键位提示；窗口渲染防超页（选中模型居中滚动、越界贴边） */
function ModelModal(props: { modal: Extract<ModalState, { kind: "model" }> }): JSX.Element {
  const b = props.modal;
  const dims = useTerminalDimensions();
  const rows = createMemo(() => {
    // 平铺分组显示行：厂商变化时插组头「● 厂商名」，其后是该厂商模型行（缩进 4 列，与组头不对齐）
    const display: Array<{ kind: "group"; name: string } | { kind: "model"; index: number }> = [];
    let lastProvider = "";
    for (let i = 0; i < b.models.length; i++) {
      const provider = b.models[i]!.providerName ?? b.models[i]!.providerId ?? "其他";
      if (provider !== lastProvider) {
        display.push({ kind: "group", name: provider });
        lastProvider = provider;
      }
      display.push({ kind: "model", index: i });
    }
    const total = display.length;
    const selPos = Math.max(0, display.findIndex((d) => d.kind === "model" && d.index === b.selected));
    // 高度预算对齐 SessionModal：终端高减 9（输入 5+状态 2+agent/通知 2）给卡下固定内容，行高 1 行/条
    const avail = Math.max(10, (dims().height ?? 20) - 9);
    const visible = Math.max(1, Math.min(total, avail - 8));
    const start = Math.max(0, Math.min(selPos - Math.floor((visible - 1) / 2), total - visible));
    const windowed = display.slice(start, start + visible);
    const items = windowed.map((d) =>
      d.kind === "group" ? (
        <text paddingX={1} fg={theme.textMuted}>
          ● {d.name}
        </text>
      ) : (
        <text paddingX={1} fg={d.index === b.selected ? theme.foregroundAccent : theme.text}>
          {"    "}
          {d.index === b.selected ? `▸ ${b.models[d.index]!.id}` : `  ${b.models[d.index]!.id}`}
        </text>
      ),
    );
    // 溢出指示只计模型数（total 含组头，不计入以免数字与模型数不符）
    const modelCount = b.models.length;
    const visibleModels = windowed.filter((d) => d.kind === "model").length;
    const overflow = modelCount > visibleModels ? `（${visibleModels}/${modelCount}）` : "";
    items.push(
      <text paddingX={1} fg={theme.textMuted}>
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