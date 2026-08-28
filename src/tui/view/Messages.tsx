/**
 * 消息流：按 opencode 观感渲染 state.blocks 与流式尾（M4.4 收尾打磨批 + 新任务 5）。
 * 每个块前有 3 列衬线：首行放一个圆点标记（●，按来源着色：你/模型=浅蓝、工具/思考/子agent=灰、
 * 通知=红警示），后续行只空不标——一眼分清哪条是自己、哪条是模型、哪个是工具调用。
 * 工具卡片 rounded 框线 + 边框内标题（状态图标 + 工具名），参数/输出点击折叠（折叠头 onMouseUp）；
 * 子 agent 活动行带结论/合并；错误块红色标记。
 * 块与块之间以一行空行分隔（marginTop）；消息区滑动条显式可见。
 * 所有展示状态在 state，本组件只读呈现。
 */
import { For, Show, createSignal } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { BlockView, MessageBlock, ToolBlock, NoticeBlock, Streaming } from "../state.js";
import { theme } from "./theme.js";

/** 状态图标/颜色：进行中 spinner（黄=进行中，E-2/3 语义统一）、成功绿、失败红、待执行暗 */
function toolStatus(b: ToolBlock): { icon: string; fg: string } {
  switch (b.status) {
    case "running":
      return { icon: "⠋", fg: theme.running };
    case "success":
      return { icon: "✓", fg: theme.success };
    case "failure":
      return { icon: "✕", fg: theme.error };
    default:
      return { icon: "…", fg: theme.textMuted };
  }
}

/** 块来源 → 首行圆点标记的颜色（你=绿、模型=浅蓝、工具/思考/子agent=灰、通知=红警示） */
function markerFor(b: BlockView): string {
  if (b.kind === "message") return b.role === "user" ? theme.success : theme.modelColor;
  if (b.kind === "tool") return theme.textMuted;
  if (b.kind === "notice") return theme.warning;
  return theme.textMuted;
}

/** 折叠点击判定：记录左键按下位置，仅同点抬起才算点击（拖选文本、外部拖入、右键/中键抬起不折叠）。
 *  不用 opentui 的 isDragging——可选中文本上普通点击的 up 也带 isDragging，会误杀「点内容收起」。 */
function useFoldClick(onFold: () => void): {
  onMouseDown: (e: { button: number; x: number; y: number }) => void;
  onMouseUp: (e: { button: number; x: number; y: number }) => void;
} {
  let down: { x: number; y: number } | null = null;
  return {
    onMouseDown: (e) => {
      if (e.button === 0) down = { x: e.x, y: e.y };
    },
    onMouseUp: (e) => {
      if (e.button === 0 && down && down.x === e.x && down.y === e.y) onFold();
      down = null;
    },
  };
}

/** 块衬线：左侧 3 列「●  」+ 内容列（内容整体缩进到第 3 列，后续行只空不标） */
function MarkedBlock(props: { markerColor: string; children: JSX.Element }): JSX.Element {
  return (
    <box flexDirection="row">
      <box width={3} flexShrink={0}>
        <text fg={props.markerColor}>●</text>
      </box>
      <box flexDirection="column" flexGrow={1} flexShrink={0}>
        {props.children}
      </box>
    </box>
  );
}

/** 可折叠区悬停临时态（E-1=35）：onMouseOver/onMouseOut 切换折叠摘要行灰文字变白（theme.text），
 *  移开恢复灰（不再整块背景抬高）；仅折叠摘要行生效，展开内容保持灰、正文/状态行不受影响 */
function useHoverFg(): {
  fg: () => string;
  onMouseOver: () => void;
  onMouseOut: () => void;
} {
  const [hover, setHover] = createSignal(false);
  return {
    fg: () => (hover() ? theme.text : theme.textMuted),
    onMouseOver: () => setHover(true),
    onMouseOut: () => setHover(false),
  };
}

/** 折叠块容器属性合并：点击折叠（fold）+ 悬停文字变白（hover）同挂一个 box，属性不冲突 */
function useFoldHover(onFold: () => void): {
  fg: () => string;
  onMouseDown: (e: { button: number; x: number; y: number }) => void;
  onMouseUp: (e: { button: number; x: number; y: number }) => void;
  onMouseOver: () => void;
  onMouseOut: () => void;
} {
  const fold = useFoldClick(onFold);
  const hover = useHoverFg();
  return { fg: hover.fg, onMouseDown: fold.onMouseDown, onMouseUp: fold.onMouseUp, onMouseOver: hover.onMouseOver, onMouseOut: hover.onMouseOut };
}

/** 思考折叠：收起一行「思考（▸ n）」，展开显示内容；整块左键同点点击切换（内容长时点任意部位收起） */
function ThinkingFold(props: { text: string; collapsed: boolean; onFold: () => void }): JSX.Element {
  const width = Array.from(props.text).length;
  const h = useFoldHover(props.onFold);
  return (
    <box flexDirection="column" onMouseDown={h.onMouseDown} onMouseUp={h.onMouseUp} onMouseOver={h.onMouseOver} onMouseOut={h.onMouseOut}>
      <box>
        <text fg={h.fg()}>
          {props.collapsed ? (
            <span>思考（▸ {width}，点击展开）</span>
          ) : (
            <span>▼ 思考（点击收起）</span>
          )}
        </text>
      </box>
      <Show when={!props.collapsed}>
        {/* 展开内容保持灰色调（与折叠提示同灰，用户复核：展开后也应灰色显示） */}
        <text fg={theme.textMuted}>{props.text}</text>
      </Show>
    </box>
  );
}

/** 单条消息块：用户/助手，含点击可切换的思考折叠与错误标记 */
function MessageView(props: { b: MessageBlock; modelLabel: string; onFold: () => void }): JSX.Element {
  const label = props.b.role === "user" ? "你" : props.modelLabel;
  return (
    <box flexDirection="column">
      <text fg={theme.textMuted}>
        {props.b.isError ? <span style={{ fg: theme.error }}>⚠ </span> : null}
        <span style={{ fg: props.b.role === "user" ? theme.success : theme.modelColor }}>
          {label}
        </span>{" "}
        {props.b.time ?? ""}
      </text>
      {/* 思考在前、结论文本在后（用户复核：先看到思考，再看到结论） */}
      <Show when={props.b.thinking}>
        <ThinkingFold text={props.b.thinking!} collapsed={props.b.thinkingCollapsed} onFold={props.onFold} />
      </Show>
      <Show when={props.b.text}>
        <text>{props.b.text}</text>
      </Show>
    </box>
  );
}

/** 工具调用卡片（③工具浓缩，opencode 风格，用户确认 4 点）：
 *  - compact（glob/read/grep/ls 只读快工具）：完成收敛单行摘要「✱ Read 参数摘要 · 输出 N 行」，鼠标点击展开参数与输出全文
 *  - bash：去框线紧凑块——首行状态 + 命令摘要，超长输出折叠为行数提示，鼠标点击切换
 *  - generic（未特判工具）：默认单行「⚙ 名 参数」，输出隐藏，鼠标点击展开
 *  全部展开/关闭一律鼠标点击（复用整卡左键同点判定）；折叠字段复用 collapsedOutput/collapsedArgs */
const COMPACT_TOOLS = new Set(["glob", "read", "grep", "ls"]);

function toolDisplayMode(name: string | undefined): "compact" | "bash" | "generic" {
  const n = (name ?? "").toLowerCase();
  if (n === "bash") return "bash";
  if (COMPACT_TOOLS.has(n)) return "compact";
  return "generic";
}

/** 参数摘要（G-4=42）：优先取 path/file/command/pattern 等已知键名（content 排在前面也不误导），
 *  无已知键再取任意首字符串；长则截断；非 JSON 用原文截断 */
const ARGS_PREFERRED_KEYS = ["path", "file", "command", "pattern", "query", "message", "target"];
function argsDigest(args: string, max = 40): string {
  let s = args;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const preferred =
      ARGS_PREFERRED_KEYS.map((k) => parsed[k]).find((v): v is string => typeof v === "string") ??
      Object.values(parsed).find((v): v is string => typeof v === "string");
    if (preferred != null) s = preferred;
  } catch {
    // 非 JSON 参数用原文
  }
  // 按码点截断（emoji 代理对不切成乱码，轻微 5 审查）
  return Array.from(s).length > max ? `${Array.from(s).slice(0, max).join("")}…` : s;
}

function ToolView(props: { b: ToolBlock; onFold: () => void }): JSX.Element {
  const b = props.b;
  const status = toolStatus(b);
  const mode = toolDisplayMode(b.name);
  const h = useFoldHover(props.onFold);
  const foldBox = {
    onMouseDown: h.onMouseDown,
    onMouseUp: h.onMouseUp,
    onMouseOver: h.onMouseOver,
    onMouseOut: h.onMouseOut,
  };

  if (mode === "compact") {
    const expanded = !b.collapsedOutput;
    const outputLines = b.output ? b.output.trimEnd().split("\n").length : 0;
    return (
      <box flexDirection="column" {...foldBox}>
        <text fg={h.fg()}>
          <span style={{ fg: status.fg }}>{status.icon}</span> {b.name ?? "tool"}
          {b.args ? ` ${argsDigest(b.args)}` : ""}
          {b.status === "running" ? (
            ""
          ) : hasOutput(b) && !expanded ? ` · 输出 ${outputLines} 行 · 点击展开` : ""}
        </text>
        <Show when={expanded && b.args}>
          <text fg={theme.textMuted}>{b.args}</text>
        </Show>
        <Show when={expanded && b.output}>
          <text fg={theme.textMuted}>{b.output}</text>
        </Show>
        <Show when={expanded && b.error}>
          <text fg={theme.error}>{b.error}</text>
        </Show>
      </box>
    );
  }
  if (mode === "bash") {
    // bash：去框线紧凑——首行状态 + 命令摘要，输出按折叠切换（保留输出块无边框）
    return (
      <box flexDirection="column" {...foldBox}>
        <text>
          <span style={{ fg: status.fg }}>{status.icon}</span> <span style={{ fg: h.fg() }}>Bash</span>{" "}
          {b.args ? argsDigest(b.args, 60) : ""}
        </text>
        <Show when={hasOutput(b)}>
          {b.collapsedOutput ? (
            <text fg={h.fg()}>
              ▾ {b.error ? "错误详情" : `输出 ${(b.output ?? "").trimEnd().split("\n").length} 行`} · 点击展开
            </text>
          ) : (
            <Show when={b.output}>
              <text fg={theme.textMuted}>{b.output}</text>
            </Show>
          )}
          {!b.collapsedOutput && b.error ? <text fg={theme.error}>{b.error}</text> : null}
        </Show>
      </box>
    );
  }
  // generic：默认单行 icon+名+参数，输出隐藏；展开显示输出（完成后同样可点开）
  return (
    <box flexDirection="column" {...foldBox}>
      <text fg={h.fg()}>
        <span style={{ fg: status.fg }}>{status.icon}</span> {b.name ?? "tool"}
        {b.args ? ` ${argsDigest(b.args, 48)}` : ""}
        {/* D-5=70：generic（含协作工具 send_message 等）摘要行补「输出 N 行」；只有错误无输出时显「错误详情」（审查 D-3） */}
        {hasOutput(b) && b.collapsedOutput
          ? b.output
            ? ` · 输出 ${b.output.trimEnd().split("\n").length} 行 · 点击展开`
            : " · 错误详情 · 点击展开"
          : ""}
      </text>
      <Show when={!b.collapsedOutput && b.output}>
        <text fg={theme.textMuted}>{b.output}</text>
      </Show>
      <Show when={!b.collapsedOutput && b.error}>
        <text fg={theme.error}>{b.error}</text>
      </Show>
    </box>
  );
}

function hasOutput(b: ToolBlock): boolean {
  return Boolean(b.output || b.error);
}

/** 子 agent 活动行：派生/完成（结论+合并可折叠）/中断——结论/合并长内容平时收敛单行，
 *  点击展开（用户复核：子 agent 结果应像工具一样支持展开/关闭） */
function AgentView(props: { b: Extract<BlockView, { kind: "agent" }>; onFold: () => void }): JSX.Element {
  const b = props.b;
  const foldable = b.event === "completed" && Boolean(b.conclusion || b.mergeResult);
  const h = useFoldHover(props.onFold);
  return (
    <box
      flexDirection="column"
      // 不可折叠（派生/中断）时不挂任何鼠标监听，整行纯展示
      {...(foldable
        ? { onMouseDown: h.onMouseDown, onMouseUp: h.onMouseUp, onMouseOver: h.onMouseOver, onMouseOut: h.onMouseOut }
        : {})}
    >
      <text fg={h.fg()}>
        <span style={{ fg: theme.foregroundAccent }}>⑂</span> 子 agent [{b.path}]
        {b.event === "spawned"
          ? " 已派生"
          : b.event === "completed"
            ? ` 完成${b.conclusion ? ` · 输出 ${b.conclusion.trimEnd().split("\n").length} 行` : ""}${foldable && b.collapsed ? "（▸ 点击展开）" : ""}`
            : " 中断"}
      </text>
      <Show when={foldable && !b.collapsed}>
        <text fg={theme.textMuted}>
          {b.conclusion ? `结论：${b.conclusion}` : null}
          {b.conclusion && b.mergeResult ? "\n" : null}
          {b.mergeResult ? `合并：${b.mergeResult}` : null}
        </text>
      </Show>
    </box>
  );
}

/** 系统通知行（模型路由切换等）：常驻消息区展示（非 toast），警示色 */
function NoticeView(props: { b: NoticeBlock }): JSX.Element {
  return <text fg={theme.warning}>{props.b.text}</text>;
}

/** 流式尾：思考与文本增量累积（state.streaming） */
function StreamingView(props: { s: Streaming }): JSX.Element {
  return (
    <box flexDirection="column">
      <Show when={props.s.thinking}>
        <text fg={theme.textMuted}>思考（展开中…）</text>
      </Show>
      <Show when={props.s.text}>
        <text>{props.s.text}</text>
      </Show>
    </box>
  );
}

function blockView(b: BlockView, modelLabel: string, onFold: () => void): JSX.Element {
  if (b.kind === "message") return <MessageView b={b} modelLabel={modelLabel} onFold={onFold} />;
  if (b.kind === "tool") return <ToolView b={b} onFold={onFold} />;
  if (b.kind === "notice") return <NoticeView b={b} />;
  return <AgentView b={b} onFold={onFold} />;
}

export function Messages(props: {
  blocks: BlockView[];
  modelLabel: string;
  streaming?: Streaming;
  onFoldAt?: (index: number) => void;
}): JSX.Element {
  // F-2=57 滚轮加速：opentui 原生每次滚 1 行太慢。scrollbox 的 onMouseEvent 是原型方法——
  // 直接 spread 覆盖会遮蔽原生滚动（S2 审查确认）。改用 ref 包装：先放大 delta 再调原生实现，
  // 不遮蔽。WeakSet 防 ref 重复调用时叠加包装。滚轮与滚动条拖拽同走 scroll 事件，拖拽也被 ×3
  // （更快，方向无害，M3 注释澄清）。
  const boostedScrollboxes = new WeakSet<object>();
  const boostWheel = (el: unknown): void => {
    if (!el || boostedScrollboxes.has(el)) return;
    boostedScrollboxes.add(el);
    const box = el as { onMouseEvent?: (e: unknown) => void };
    const orig = box.onMouseEvent?.bind(box);
    box.onMouseEvent = (e: unknown) => {
      const ev = e as { type: string; scroll?: { delta: number } };
      if (ev.type === "scroll" && ev.scroll) ev.scroll.delta *= 3;
      orig?.(e);
    };
  };
  return (
    <scrollbox
      flexGrow={1}
      paddingX={1}
      stickyScroll={true}
      stickyStart="bottom"
      ref={boostWheel}
      verticalScrollbarOptions={{
        trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
      }}
    >
      <For each={props.blocks}>
        {(b, i) => (
          <box flexShrink={0} marginTop={1}>
            <MarkedBlock markerColor={markerFor(b)}>
              {blockView(b, props.modelLabel, () => props.onFoldAt?.(i()))}
            </MarkedBlock>
          </box>
        )}
      </For>
      {props.streaming ? (
        <box flexShrink={0} marginTop={1}>
          <MarkedBlock markerColor={theme.textMuted}>
            <StreamingView s={props.streaming} />
          </MarkedBlock>
        </box>
      ) : null}
      {props.blocks.length === 0 && !props.streaming ? (
        <box flexShrink={0} marginTop={1}>
          <text fg={theme.textMuted}>开始对话吧——输入消息后回车。</text>
        </box>
      ) : null}
    </scrollbox>
  );
}