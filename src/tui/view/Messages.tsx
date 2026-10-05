/**
 * 消息流：渲染 state.blocks 与流式尾。
 * 每个块前有 3 列衬线：首行放一个圆点标记（●，按来源着色：你/模型=浅蓝、工具/思考/子agent=灰、
 * 通知=红警示），后续行只空不标——一眼分清哪条是自己、哪条是模型、哪个是工具调用。
 * 工具卡片 rounded 框线 + 边框内标题（状态图标 + 工具名），参数/输出点击折叠（折叠头 onMouseUp）；
 * 子 agent 活动行带结论/合并，失败终态按红色标记；错误块红色标记。
 * 块与块之间以一行空行分隔（marginTop）；消息区滑动条显式可见。
 * 所有展示状态在 state，本组件只读呈现。
 */
import { For, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { MacOSScrollAccel } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { isFoldable } from "../state.js";
import type { BlockView, CommandBlock, MessageBlock, ToolBlock, NoticeBlock, Streaming } from "../state.js";
import { messageScroller, noteScrollPosition, noteUserScroll, followOnViewportResize } from "../scroll.js";
import { theme } from "./theme.js";

/** 状态图标/颜色：进行中 spinner（黄=进行中）、成功绿、失败红、待执行暗 */
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

/** 块来源 → 首行圆点标记的颜色（你=绿、模型=浅蓝、工具/思考/子agent=灰、子agent失败=红、通知=红警示） */
function markerFor(b: BlockView): string {
  if (b.kind === "message") return b.role === "user" ? theme.success : theme.modelColor;
  if (b.kind === "tool") return theme.textMuted;
  if (b.kind === "agent") return b.event === "failed" ? theme.error : theme.textMuted;
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

/** 块衬线：左侧 3 列「●  」+ 内容列（内容整体缩进到第 3 列，后续行只空不标）。
 *  内容列不设 flexShrink=0。文本节点的 max-content 宽度是最长一行的长度，列不收缩时
 *  长行（长 URL/长串）把列撑得比可用宽度更宽，行右端被裁。实测（见
 *  tests/tui/scroll-stream.test.tsx 的 E135 两例）：列不收缩时，流式尾出现超宽长行后
 *  节点高度不再随增量增长（停在可用高度），其后内容不渲染也不可滚动，即最后一条消息
 *  底部缺行；列可收缩时按可用宽度折行，高度正常增长。一次性创建的消息块同数据下正常。 */
function MarkedBlock(props: { markerColor: string; children: JSX.Element }): JSX.Element {
  return (
    <box flexDirection="row">
      <box width={3} flexShrink={0}>
        <text fg={props.markerColor}>●</text>
      </box>
      <box flexDirection="column" flexGrow={1}>
        {props.children}
      </box>
    </box>
  );
}

/** 可折叠区悬停临时态：onMouseOver/onMouseOut 切换折叠摘要行灰文字变白（theme.text），
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
        {/* 展开内容保持灰色调（与折叠提示同灰，展开后也应灰色显示） */}
        <text fg={theme.textMuted}>{props.text}</text>
      </Show>
    </box>
  );
}

/** 单条消息块：用户/助手，含点击可切换的思考折叠与错误标记。
 *  助手署名跟随消息的实际产出模型（路由切到备选后归属正确），缺省回落会话当前模型 */
function MessageView(props: { b: MessageBlock; modelLabel: string; onFold: () => void }): JSX.Element {
  const label = props.b.role === "user" ? "你" : (props.b.model ?? props.modelLabel);
  return (
    <box flexDirection="column">
      <text fg={theme.textMuted}>
        {props.b.isError ? <span style={{ fg: theme.error }}>⚠ </span> : null}
        <span style={{ fg: props.b.role === "user" ? theme.success : theme.modelColor }}>
          {label}
        </span>{" "}
        {props.b.time ?? ""}
      </text>
      {/* 思考在前、结论文本在后（先看到思考，再看到结论） */}
      <Show when={props.b.thinking}>
        <ThinkingFold text={props.b.thinking!} collapsed={props.b.thinkingCollapsed} onFold={props.onFold} />
      </Show>
      <Show when={props.b.text}>
        <text>{props.b.text}</text>
      </Show>
    </box>
  );
}

/** 工具调用卡片（工具浓缩）：
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

/** 参数摘要：优先取 path/file/command/pattern 等已知键名（content 排在前面也不误导），
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
  // 按码点截断（emoji 代理对不切成乱码）
  return Array.from(s).length > max ? `${Array.from(s).slice(0, max).join("")}…` : s;
}

/** 执行耗时文案：完成/失败卡显示「· 耗时 1.2s」，不足 1 秒记 ms；
 *  执行前被拒（无 durationMs 事件）与被中断（无 PostToolUse）无耗时不显示 */
function durationText(b: ToolBlock): string {
  if (b.durationMs === undefined) return "";
  if (b.durationMs < 1000) return ` · 耗时 ${b.durationMs}ms`;
  return ` · 耗时 ${(b.durationMs / 1000).toFixed(1)}s`;
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
          {durationText(b)}
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
          {durationText(b)}
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
        {durationText(b)}
        {/* generic（含协作工具 send_message 等）摘要行补「输出 N 行」；只有错误无输出时显「错误详情」 */}
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

/** 子 agent 活动行：派生/完成（结论+合并可折叠）/失败（失败文本，红字）/中断——结论长内容平时收敛单行，
 *  点击展开（子 agent 结果应像工具一样支持展开/关闭） */
function AgentView(props: { b: Extract<BlockView, { kind: "agent" }>; onFold: () => void }): JSX.Element {
  const b = props.b;
  // 折叠判定复用 state 的 isFoldable（原先视图另抄了一份同样条件，改一处易漏改）；
  // 工具卡片的参数与输出是两个独立开关，不走这里
  const foldable = isFoldable(b);
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
        {b.event === "spawned" ? " 已派生" : null}
        {b.event === "interrupted" ? " 中断" : null}
        {/* 失败终态：红字「失败」，与完成的「完成」一眼分开（此前两者同形） */}
        {b.event === "failed" ? <span style={{ fg: theme.error }}> 失败</span> : null}
        {b.event === "completed" ? " 完成" : null}
        {b.event === "completed" && b.conclusion
          ? ` · 输出 ${b.conclusion.trimEnd().split("\n").length} 行`
          : ""}
        {/* 空结论（模型未产出正文）：警示措辞与色，不与真完成同形 */}
        {b.event === "completed" && !b.conclusion ? (
          <span style={{ fg: theme.warning }}> · 未产出结论</span>
        ) : null}
        {foldable && b.collapsed ? "（▸ 点击展开）" : ""}
      </text>
      <Show when={foldable && !b.collapsed}>
        {/* 失败详情用红色，与工具卡片的错误详情同口径（失败是需要看见的信息，不压成普通灰字） */}
        <text fg={b.event === "failed" ? theme.error : theme.textMuted}>
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

/** 命令块：一条命令一行，弱化展示——执行过程不铺屏，命令本身有痕迹可循 */
function CommandView(props: { b: CommandBlock }): JSX.Element {
  return (
    <text fg={theme.textMuted}>
      <span style={{ fg: theme.foregroundAccent }}>› </span>
      {props.b.text}
    </text>
  );
}

/**
 * 流式尾：思考与文本增量累积（state.streaming）。导出供层 1 用例直接驱动「收尾当次更新
 * 读到空 streaming」这一形态（生产路径仍只由 Messages 渲染）。
 * props.s 按可空读取：收尾把 state.streaming 置空的那一次更新里，本组件的条件求值可能
 * 先于外层「有流式才渲染」的移除生效，此时 props.s 已是 undefined，直接读 thinking/text
 * 会抛 TypeError。该异常沿宿主渲染回调上抛会中断本轮收尾（assistant 不落盘、轮末 Stop
 * 不发，界面永久停在运行中），真机恢复会话后的首条消息上出现过。
 */
export function StreamingView(props: { s?: Streaming }): JSX.Element {
  return (
    <box flexDirection="column">
      <Show when={props.s?.thinking}>
        <text fg={theme.textMuted}>思考（展开中…）</text>
      </Show>
      <Show when={props.s?.text}>
        <text>{props.s?.text}</text>
      </Show>
    </box>
  );
}

function blockView(b: BlockView, modelLabel: string, onFold: () => void): JSX.Element {
  if (b.kind === "message") return <MessageView b={b} modelLabel={modelLabel} onFold={onFold} />;
  if (b.kind === "tool") return <ToolView b={b} onFold={onFold} />;
  if (b.kind === "notice") return <NoticeView b={b} />;
  if (b.kind === "command") return <CommandView b={b} />;
  return <AgentView b={b} onFold={onFold} />;
}

export function Messages(props: {
  blocks: BlockView[];
  modelLabel: string;
  streaming?: Streaming;
  onFoldAt?: (index: number) => void;
}): JSX.Element {
  // 滚动接线：scrollbox 注册进 messageScroller（键盘翻页/强制回底经它调用）；
  // 滚轮只同步「是否在读历史」标记，不再放大 delta——滚动加速交给 opentui 内置
  // scrollAcceleration（手势越快滚得越多），替代旧的 ×5 改写实例方法 hack
  const registerScroller = (el: unknown): void => {
    if (!el) {
      messageScroller.box = null;
      return;
    }
    const box = el as {
      scrollTop: number;
      scrollHeight: number;
      viewport: { height: number; onSizeChange?: () => void };
      onMouseEvent?: (e: unknown) => void;
      scrollBy: (delta: number, unit?: "absolute" | "viewport") => void;
      verticalScrollBar?: { slider?: { onChange?: (value: number) => void } };
    };
    // 视口高度变化（输入框长高/回落让位、终端改行数）：跟随态下兜底回底。
    // 原回调是 opentui 内部滚动条重算，必须保留调用，只在其后追加跟随兜底
    const viewport = box.viewport;
    const origOnSizeChange = viewport.onSizeChange;
    viewport.onSizeChange = () => {
      origOnSizeChange?.();
      followOnViewportResize();
    };
    const orig = box.onMouseEvent?.bind(box);
    box.onMouseEvent = (e: unknown) => {
      orig?.(e);
      // 滚后同步标记（先滚再判定，「向下滚回到底」才看得到滚后位置）；
      // 仅纵向滚轮参与——Shift+滚轮被 opentui 重映射为横向滚动，不动跟随态
      const ev = e as { type: string; scroll?: { direction?: string } };
      if (ev.type === "scroll") {
        if (ev.scroll?.direction === "up") noteUserScroll("up");
        else if (ev.scroll?.direction === "down") noteUserScroll("down");
      }
    };
    // 拖滚动条不经鼠标滚轮事件：滑块回调里按滚动后位置同步标记（拖离底部进入读历史态，
    // 拖回底部恢复跟随），否则 blocks 增长的跟随兜底会把拖拽中的视口拽回底部
    const slider = box.verticalScrollBar?.slider;
    if (slider) {
      const origOnChange = slider.onChange?.bind(slider);
      slider.onChange = (value: number) => {
        origOnChange?.(value);
        noteScrollPosition();
      };
    }
    messageScroller.box = {
      get scrollTop() {
        return box.scrollTop;
      },
      get scrollHeight() {
        return box.scrollHeight;
      },
      get viewportHeight() {
        return box.viewport.height;
      },
      scrollBy: (delta, unit) => box.scrollBy(delta, unit),
      scrollToTop: () => {
        box.scrollTop = 0;
      },
      scrollToBottom: () => {
        box.scrollTop = Math.max(0, box.scrollHeight - box.viewport.height);
      },
    };
  };
  onCleanup(() => {
    messageScroller.box = null;
    // 读历史态一并复位：会话切换重建 App 但模块单例还在，残留 true 会让新会话
    // 首屏历史的跟随兜底失效（重挂载本就重建 scrollbox、位置归零，语义一致）
    messageScroller.userScrolled = false;
  });
  // 跟随兜底：blocks 增长/流式更新后贴底（opentui sticky 在内容一帧内高度跳变时
  // 会误判为手动滚动而脱附且无自愈）；用户在读历史（滚轮向上/翻页/回顶/拖滚动条）时
  // 不拽回，跟随由 userScrolled 标记门控（用户提交经 forceScrollToBottom 解除）
  createEffect(() => {
    void props.blocks.length;
    void props.streaming;
    if (!messageScroller.userScrolled) messageScroller.box?.scrollToBottom();
  });
  return (
    <scrollbox
      flexGrow={1}
      paddingX={1}
      stickyScroll={true}
      stickyStart="bottom"
      scrollAcceleration={new MacOSScrollAccel()}
      ref={registerScroller}
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