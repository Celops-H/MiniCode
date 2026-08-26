/**
 * 消息流：按 opencode 观感渲染 state.blocks 与流式尾（M4.4 收尾打磨批 + 新任务 5）。
 * 每个块前有 3 列衬线：首行放一个圆点标记（●，按来源着色：你=强调紫、模型=灰、工具=警示橙），
 * 后续行只空不标——一眼分清哪条是自己、哪条是模型、哪个是工具调用。
 * 工具卡片 rounded 框线 + 边框内标题（状态图标 + 工具名），参数/输出点击折叠（折叠头 onMouseUp）；
 * 子 agent 活动行带结论/合并；错误块红色标记。
 * 块与块之间以一行空行分隔（marginTop）；消息区滑动条显式可见。
 * 所有展示状态在 state，本组件只读呈现。
 */
import { For, Show } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { BlockView, MessageBlock, ToolBlock, NoticeBlock, Streaming } from "../state.js";
import { theme } from "./theme.js";

/** 状态图标/颜色：进行中 spinner、成功绿、失败红、待执行暗 */
function toolStatus(b: ToolBlock): { icon: string; fg: string } {
  switch (b.status) {
    case "running":
      return { icon: "⠋", fg: theme.warning };
    case "success":
      return { icon: "✓", fg: theme.success };
    case "failure":
      return { icon: "✕", fg: theme.error };
    default:
      return { icon: "…", fg: theme.textMuted };
  }
}

/** 块来源 → 首行圆点标记的颜色（你=强调紫、模型/子agent=灰、工具=警示橙、通知=警示橙） */
function markerFor(b: BlockView): string {
  if (b.kind === "message") return b.role === "user" ? theme.foregroundAccent : theme.textMuted;
  if (b.kind === "tool" || b.kind === "notice") return theme.warning;
  return theme.textMuted;
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

/** 思考折叠：收起一行「思考（▸ n）」，展开显示内容；整块点击切换（内容长时点任意部位收起） */
function ThinkingFold(props: { text: string; collapsed: boolean; onFold: () => void }): JSX.Element {
  const width = Array.from(props.text).length;
  return (
    <box flexDirection="column" onMouseUp={props.onFold}>
      <box>
        <text fg={theme.textMuted}>
          {props.collapsed ? (
            <span>思考（▸ {width}，点击展开）</span>
          ) : (
            <span style={{ fg: theme.text }}>
              <span style={{ fg: theme.textMuted }}>▼ 思考（点击收起）</span>
            </span>
          )}
        </text>
      </box>
      <Show when={!props.collapsed}>
        <text>{props.text}</text>
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
        <span style={{ fg: props.b.role === "user" ? theme.foregroundAccent : theme.textMuted }}>
          {label}
        </span>{" "}
        {props.b.time ?? ""}
      </text>
      <Show when={props.b.text}>
        <text>{props.b.text}</text>
      </Show>
      <Show when={props.b.thinking}>
        <ThinkingFold text={props.b.thinking!} collapsed={props.b.thinkingCollapsed} onFold={props.onFold} />
      </Show>
    </box>
  );
}

/** 工具调用卡片：rounded 框线 + 边框内标题（状态图标 + 工具名）+ 参数/输出/错误；
 *  整卡点击折叠（onMouseUp 在卡片本体，参数长/输出多时点任意部位收起） */
function ToolView(props: { b: ToolBlock; onFold: () => void }): JSX.Element {
  const status = toolStatus(props.b);
  const hasOutput = Boolean(props.b.output || props.b.error);
  const hint =
    props.b.collapsedOutput && hasOutput
      ? props.b.output
        ? `▾ 输出 ${props.b.output.replace(/\n$/, "").split("\n").length} 行 · 点击展开`
        : "▾ 错误详情 · 点击展开"
      : "";
  return (
    <box
      border={true}
      borderStyle="rounded"
      borderColor={props.b.status === "success" ? theme.border : status.fg}
      flexDirection="column"
      title={`${status.icon} ${props.b.name ?? "tool"}`}
      titleColor={status.fg}
      onMouseUp={props.onFold}
    >
      {props.b.args ? (
        <box flexDirection="column">
          <text fg={theme.textMuted} paddingX={1}>
            {props.b.collapsedArgs
              ? props.b.args.length > 60
                ? `${props.b.args.slice(0, 60)}…（${props.b.args.length} 字符，点击展开）`
                : props.b.args
              : props.b.args}
          </text>
        </box>
      ) : null}
      <Show when={props.b.output && !props.b.collapsedOutput}>
        <text paddingX={1}>{props.b.output}</text>
      </Show>
      <Show when={props.b.error && !props.b.collapsedOutput}>
        <text fg={theme.error} paddingX={1}>
          {props.b.error}
        </text>
      </Show>
      {hint ? (
        <text fg={theme.textMuted} paddingX={1} paddingTop={1}>
          {hint}
        </text>
      ) : null}
    </box>
  );
}

/** 子 agent 活动行：派生/完成（结论+合并）/中断 */
function AgentView(props: { b: Extract<BlockView, { kind: "agent" }> }): JSX.Element {
  const b = props.b;
  return (
    <text fg={theme.textMuted}>
      <span style={{ fg: theme.foregroundAccent }}>⑂</span> 子 agent [{b.path}]
      {b.event === "spawned"
        ? " 已派生"
        : b.event === "completed"
          ? ` 完成${b.conclusion ? `：${b.conclusion}` : ""}${b.mergeResult ? `（${b.mergeResult}）` : ""}`
          : " 中断"}
    </text>
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
  return <AgentView b={b} />;
}

export function Messages(props: {
  blocks: BlockView[];
  modelLabel: string;
  streaming?: Streaming;
  onFoldAt?: (index: number) => void;
}): JSX.Element {
  return (
    <scrollbox
      flexGrow={1}
      paddingX={1}
      stickyScroll={true}
      stickyStart="bottom"
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