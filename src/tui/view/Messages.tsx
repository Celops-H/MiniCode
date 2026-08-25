/**
 * 消息流（R2）：按 opencode 观感渲染 state.blocks 与流式尾。
 * 用户消息带头部「你 + 时间」；助手文本 + 思考折叠（默认收起一行，Enter 切换由 reducer 驱动）；
 * 工具卡片带状态图标与可折叠输出；子 agent 活动行带结论/合并；错误块红色标记。
 * 所有展示状态（thinkingCollapsed/collapsedOutput 等）都在 state，本组件只读呈现。
 */
import { For, Show } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { BlockView, MessageBlock, ToolBlock, Streaming } from "../state.js";
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

/** 思考折叠：收起一行「思考（▸ n）」，展开显示内容；Enter 切换由 reducer 改 thinkingCollapsed */
function ThinkingFold(props: { text: string; collapsed: boolean }): JSX.Element {
  const width = Array.from(props.text).length;
  return (
    <text fg={theme.textMuted}>
      {props.collapsed ? (
        <span>思考（▸ {width}，Enter 展开）</span>
      ) : (
        <span style={{ fg: theme.text }}>
          <span style={{ fg: theme.textMuted }}>▼ 思考（Enter 收起）</span>
          {"\n"}
          {props.text}
        </span>
      )}
    </text>
  );
}

/** 单条消息块：用户/助手，含思考折叠与错误标记 */
function MessageView(props: { b: MessageBlock; modelLabel: string }): JSX.Element {
  const label = props.b.role === "user" ? "你" : props.modelLabel;
  return (
    <box flexDirection="column" paddingY={1}>
      <text fg={theme.textMuted}>
        {props.b.isError ? <span style={{ fg: theme.error }}>⚠ </span> : null}
        {label} {props.b.time ?? ""}
      </text>
      <Show when={props.b.text}>
        <text>{props.b.text}</text>
      </Show>
      <Show when={props.b.thinking}>
        <ThinkingFold text={props.b.thinking!} collapsed={props.b.thinkingCollapsed} />
      </Show>
    </box>
  );
}

/** 工具调用卡片：名称 + 参数（可折叠）+ 状态图标 + 输出/错误（可折叠） */
function ToolView(props: { b: ToolBlock }): JSX.Element {
  const status = toolStatus(props.b);
  return (
    <box flexDirection="column" paddingY={1}>
      <box flexDirection="row" gap={1}>
        <text fg={status.fg}>{status.icon}</text>
        <text>{props.b.name ?? "tool"}</text>
        <text fg={theme.textMuted} flexGrow={1}>
          {props.b.collapsedArgs
            ? props.b.args.length > 40
              ? `${props.b.args.slice(0, 40)}…（${props.b.args.length} 字符，Enter 展开）`
              : props.b.args
            : props.b.args}
        </text>
      </box>
      <Show when={props.b.output && !props.b.collapsedOutput}>
        <text fg={theme.textMuted}>{props.b.output}</text>
      </Show>
      <Show when={props.b.error && !props.b.collapsedOutput}>
        <text fg={theme.error}>{props.b.error}</text>
      </Show>
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

/** 流式尾：思考与文本增量累积（state.streaming） */
function StreamingView(props: { s: Streaming }): JSX.Element {
  return (
    <box flexDirection="column" paddingY={1}>
      <Show when={props.s.thinking}>
        <text fg={theme.textMuted}>思考（展开中…）</text>
      </Show>
      <Show when={props.s.text}>
        <text>{props.s.text}</text>
      </Show>
    </box>
  );
}

function blockView(b: BlockView, modelLabel: string): JSX.Element {
  if (b.kind === "message") return <MessageView b={b} modelLabel={modelLabel} />;
  if (b.kind === "tool") return <ToolView b={b} />;
  return <AgentView b={b} />;
}

export function Messages(props: { blocks: BlockView[]; modelLabel: string; streaming?: Streaming }): JSX.Element {
  return (
    <scrollbox flexGrow={1} paddingX={1}>
      <For each={props.blocks}>
        {(b) => (
          <box flexShrink={0}>
            {blockView(b, props.modelLabel)}
          </box>
        )}
      </For>
      {props.streaming ? (
        <box flexShrink={0}>
          <StreamingView s={props.streaming} />
        </box>
      ) : null}
      {props.blocks.length === 0 && !props.streaming ? (
        <box flexShrink={0}>
          <text fg={theme.textMuted}>开始对话吧——输入消息后回车。</text>
        </box>
      ) : null}
    </scrollbox>
  );
}