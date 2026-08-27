/**
 * 嵌入弹块（R4 + 收尾打磨批 ⑪ + P6-3 弹窗观感修正）：权限确认 / 会话面板 / /connect / /model。
 * state.modal 由 loop 的 approver（权限请求）与 /session、/connect、/model 命令写入；组件只读呈现。
 * 框线风格与消息区工具卡一体：rounded 边框 + 边框内标题，分区（标题/参数/选项/键位提示）。
 * 线条统一黑白灰阶（边框/标题/分隔，P6-3 修正 C 组过犹不及：文字也黑白不染色）——
 * 仅「选中项」用浅蓝背景块（foregroundAccent 底 + 黑字）做高亮，一眼可辨且与普通文字区分。
 * 各弹窗固定宽度（超出高度窗口滚动，不随内容无限变高）。
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

/** 弹窗内层 box 固定宽度：终端宽 - 四周余量（C-2 固定大小，不随内容自适应抖动） */
function modalWidth(dims: { width?: number }): number {
  return Math.max(30, (dims.width ?? 80) - 6);
}

/** 权限确认：边框内标题 + 工具/参数 + 三决策 + 键位提示（选中项浅蓝背景块黑字，随 ←→ 移动；文字黑白不染色） */
function PermissionModal(props: { modal: Extract<ModalState, { kind: "permission" }> }): JSX.Element {
  const b = props.modal;
  const dims = useTerminalDimensions();
  // 选项行：memo 读 b.selected 重算（For+条件在此渲染器下不刷新标量，见文件头注释）
  const optionLine = createMemo(() =>
    PERMISSION_OPTIONS.map((opt, i) => {
      const sel = b.selected === i;
      return sel ? (
        <span style={{ bg: theme.foregroundAccent, fg: theme.background }}>
          [{opt.key}] {opt.label} ◀
        </span>
      ) : (
        <span style={{ fg: theme.textMuted }}> [{opt.key}] {opt.label} </span>
      );
    }),
  );
  return (
    <box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
      <box border={true} borderStyle="rounded" borderColor={theme.border} flexDirection="column" flexShrink={0} backgroundColor={theme.backgroundPanel}
        width={modalWidth(dims())} title="权限确认" titleColor={theme.textMuted}>
        <text paddingY={1}>
          工具 <span style={{ fg: theme.text }}>{b.toolName}</span>
          {b.content ? ` · ${b.content}` : ""}
        </text>
        {b.argsText ? (
          <text fg={theme.textMuted}>
            参数 {b.argsText}
          </text>
        ) : null}
        <box flexDirection="row" paddingX={1} paddingTop={1}>
          <text>{optionLine()}</text>
        </box>
        <text fg={theme.textMuted} paddingY={1}>
          1/2/3 或 ←→ 选择 · Enter 确认 · Esc 拒绝
        </text>
      </box>
    </box>
  );
}

/** 会话切换面板（P4-3 全屏化 + P5 C-3/4/5/6 + P6-4/5）：完全全屏页面（消息/输入/状态行隐藏，App 层条件渲染），
 *  四周留边距、标题与列表间空行分隔；每会话两行——主行「标题 模型 哈希」三列各自定宽对齐（P6-5 会话名
 *  第一列、间距加大），副行缩进对齐标题列；条目间空行加大间距（C-5）；
 *  「新建会话」置顶固定为第一项并默认选中（P6-4），＋ 图标 + 选中浅蓝底黑字特殊化，不随会话滚动区滚出。
 *  当前活跃会话不在列表（loop 已过滤）；选中行操作态进入/删除 ←→ 切换（P4-2）。
 *  滚动：选中项落在页底、到本页最后一个再按 ↓ 才滚下一页（C-6）；滚动只作用于会话区。 */
function SessionModal(props: { modal: Extract<ModalState, { kind: "session" }> }): JSX.Element {
  const b = props.modal;
  const dims = useTerminalDimensions();
  const rows = createMemo(() => {
    const total = b.sessions.length;
    // 列表区可用高度：外层 paddingTop(1) + 标题(1) + 标题下空行(1) + 新建会话行(1) + 新建与会话间隔(1)
    //   + 提示(1) + 底部余量(1)
    const avail = Math.max(8, (dims().height ?? 20) - 7);
    // 每条占 3 行：主行 + 副行 + 条目间空行
    const perRow = 3;
    const sessRows = Math.max(1, Math.min(total, Math.floor(avail / perRow)));
    // 会话区选中索引：selected 0=新建会话、1..n=会话（P6-4 新建置顶）；-1 表示无会话行被选中。
    // 不做下限截断：截到 0 会让第一个普通会话在「新建会话选中」时也带 ▸（P3）
    const selIndex = b.selected - 1;
    // 滚动（C-6）：选中项落在页底，到页底再按 ↓ 才滚下一页（start 随 selected 越界才增）；
    // selIndex 为 -1 时两个 min/max 结果都落回 0，滚动停在列表头
    const start = Math.max(0, Math.min(selIndex - (sessRows - 1), total - sessRows));
    const visible = b.sessions.slice(start, start + sessRows);
    // 三列（P6-5）：标题第一列、模型第二列、哈希第三列；列宽按可见内容取最大（截断上限防顶开），列间距 GAP
    const titleCols = Math.min(26, Math.max(4, ...visible.map((s) => colWidth(s.title || "新会话"))));
    const modelCols = Math.min(18, Math.max(4, ...visible.map((s) => colWidth(s.model))));
    const idCols = 6;
    const GAP = 6;
    const items: JSX.Element[] = [];
    // 新建会话固定顶部（P6-4）：不随会话滚动区滚出、无删除操作态；选中=浅蓝底黑字（与普通会话白字+操作态区分）。
    // 缩进一律用字面空格——opentui 的 text 元素水平 padding 无效（实测 captureCharFrame 无位移），
    // 只有 box 生效；行首两格与下面会话行的「▸ / 空格」标记位对齐
    const newSel = b.selected === 0;
    items.push(
      newSel ? (
        <text style={{ bg: theme.foregroundAccent, fg: theme.background }}>▸ ＋ 新建会话</text>
      ) : (
        <text fg={theme.text}>{"  "}＋ 新建会话</text>
      ),
    );
    // 新建会话与列表间隔空行
    items.push(<text> </text>);
    visible.forEach((s, i) => {
      const sel = start + i === selIndex;
      const title = padCols(fitWidth(s.title || "新会话", titleCols), titleCols);
      // 模型列同样补齐定宽：哈希列（第三列）不随各会话模型宽度错位（S-1 审查修正）
      const model = padCols(fitWidth(s.model, modelCols), modelCols);
      const idCell = padCols(s.id.slice(0, idCols), idCols);
      const actionTag = sel ? (b.action === "delete" ? "  ✕ 删除" : "  ◀ 进入") : "";
      items.push(
        <box flexDirection="column">
          <text fg={sel ? (b.action === "delete" ? theme.error : theme.text) : theme.text}>
            {`${sel ? "▸ " : "  "}${title}${" ".repeat(GAP)}${model}${" ".repeat(GAP)}${idCell}${actionTag}`}
          </text>
          {/* 副行缩进对齐第一列标题文字：外层 paddingX 2 + 字面空格 2 = 第 4 列，
              与主行「▸/空格标记 + 标题」的标题起始列一致（P4，text 的 paddingLeft 在 opentui 无效） */}
          <text fg={theme.textMuted}>
            {`  ${relativeTime(s.updatedAt)} · ${formatBytes(s.sizeBytes)}`}
          </text>
        </box>,
      );
      // 条目间空行（最后一条后不加，避免底部多余空隙）
      if (i < visible.length - 1) items.push(<text> </text>);
    });
    const overflow = total > sessRows ? `（${start + 1}-${Math.min(start + sessRows, total)}/${total}）` : "";
    items.push(
      <text fg={theme.textMuted} paddingY={1}>
        ↑↓ 选择 · ←→ 进入/删除 · Enter 确定 · Esc 返回{overflow}
      </text>,
    );
    return items;
  });
  return (
    <box flexDirection="column" flexGrow={1} flexShrink={0} backgroundColor={theme.background} paddingX={2} paddingY={1}>
      <box flexDirection="row">
        <text fg={theme.text}>会话列表</text>
        <text fg={theme.textMuted}>（{b.sessions.length} 个其它会话，Esc 返回当前会话）</text>
      </box>
      <text> </text>
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
        <text paddingY={1} fg={theme.textMuted}>
          输入 API Key · {b.providerName}
        </text>,
        <text>
          默认模型 {b.defaultModel} · {b.apiKeyEnv}：
        </text>,
        <text fg={theme.text}>
          {display}
          {/* 竖线光标（P4-5）：key 输入位置细竖线指示，明灭闪烁 */}
          <span style={{ fg: cursorOn() ? theme.text : theme.background }}>│</span>
        </text>,
        <text fg={theme.textMuted} paddingY={1}>
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
      <text paddingY={1} fg={theme.textMuted}>
        连接供应商
      </text>,
      // 供应商名只显名称、不附默认模型（C-7=62）；选中项浅蓝背景块黑字（P6 审查修正：
      // 此前只有 ▸ 无背景块，与权限/新建会话的选中观感不一致——用户要求统一）
      ...b.providers.slice(start, start + visible).map((p, i) =>
        start + i === b.selected ? (
          <text paddingTop={1}>
            <span style={{ bg: theme.foregroundAccent, fg: theme.background }}>
              ▸ {fitWidth(p.name, modalWidth(dims()) - 6)}
            </span>
          </text>
        ) : (
          <text paddingTop={1} fg={theme.textMuted}>
            {"  "}
            {fitWidth(p.name, modalWidth(dims()) - 6)}
          </text>
        ),
      ),
    ];
    const overflow = total > visible ? `（${start + 1}-${Math.min(start + visible, total)}/${total}）` : "";
    items.push(
      <text fg={theme.textMuted} paddingY={1}>
        ↑↓/←→ 选择 · Enter 输入 API Key · Esc 取消{overflow}
      </text>,
    );
    return items;
  });
  return (
    <box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
      <box border={true} borderStyle="rounded" borderColor={theme.border} flexDirection="column" flexShrink={0} backgroundColor={theme.backgroundPanel} width={modalWidth(dims())}>
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
        <text fg={theme.textMuted}>
          ● {d.name}
        </text>
      ) : d.index === b.selected ? (
        // 选中模型浅蓝背景块黑字（P6 审查修正，与权限/新建会话/connect 统一）；缩进保持 4+标记 与未选中同列
        <text>
          <span style={{ bg: theme.foregroundAccent, fg: theme.background }}>
            {"    ▸ "}
            {b.models[d.index]!.id}
          </span>
        </text>
      ) : (
        <text fg={theme.text}>
          {"    "}
          {`  ${b.models[d.index]!.id}`}
        </text>
      ),
    );
    // 溢出指示只计模型数（total 含组头，不计入以免数字与模型数不符）
    const modelCount = b.models.length;
    const visibleModels = windowed.filter((d) => d.kind === "model").length;
    const overflow = modelCount > visibleModels ? `（${visibleModels}/${modelCount}）` : "";
    items.push(
      <text fg={theme.textMuted}>
        思考等级：{thinkingLevelLabel(b.thinkingLevel)}（←→ 调整）
      </text>,
    );
    items.push(
      <text fg={theme.textMuted} paddingY={1}>
        ↑↓ 选模型 · ←→ 思考等级 · Enter 应用 · Esc 取消{overflow}
      </text>,
    );
    return items;
  });
  return (
    <box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
      <box border={true} borderStyle="rounded" borderColor={theme.border} flexDirection="column" flexShrink={0} backgroundColor={theme.backgroundPanel}
        width={modalWidth(dims())} title="选择模型" titleColor={theme.textMuted}>
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
