/**
 * 状态行（底部固定一行）：模型 · 会话标题 · 模式[default/plan mode/auto mode] · 用量三段 · 运行状态 · 操作提示。
 * 会话位显示标题（随 /rename 同步；长标题按列宽截断到 20 列），id 完整值在 /session 面板可见。
 * 运行状态三段：空闲 / 运行中（Esc 打断、连按两次退出）/ 压缩中（Esc 打断压缩）。
 * 观感：一行内分布；窄屏右侧溢出被截（自然右缘裁切）：溢出先截右侧
 * 运行状态/操作提示，继而左盒靠右的用量段依次被顶出，模型名/会话标题/模式最后被截。
 * 用量三段：↑↓ 为会话累计（含全部 agent，归一口径见
 * UsageSummary）；缓存命中率 = cacheRead/input；上下文水位 = 上下文 token/窗口（与压缩触发
 * 同一口径，到达压缩线变警示色），无数据不显示对应段。
 */
import type { JSX } from "@opentui/solid";
import { DEFAULT_CONTEXT_WINDOW } from "../../llm/index.js";
import { DEFAULT_SESSION_TITLE } from "../../storage/index.js";
import { theme } from "./theme.js";
import { permissionModeLabel, formatTokens } from "../state.js";
import { fitWidth } from "./fit.js";
import type { PermissionMode } from "../../permission/index.js";
import type { UsageSummary } from "../state.js";

export interface StatusBarProps {
  model: string;
  /** 会话标题（/rename 后同步更新；空显示「新会话」） */
  title: string;
  status: "idle" | "running" | "compacting";
  permissionMode?: PermissionMode;
  /** 会话级用量累计（恢复重建降级后仍无数据时不渲染用量区） */
  usage?: UsageSummary;
  /** root 上下文估算 token（水位分子） */
  contextTokens?: number;
  /** 模型上下文窗口（水位分母），与 contextTokens 齐备才显示水位段 */
  contextWindow?: number;
  /** 自动压缩触发线：水位到达即警示色（再聊就要压了） */
  compactThreshold?: number;
}

export function StatusBar(props: StatusBarProps): JSX.Element {
  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} paddingX={1} flexShrink={0}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={theme.modelColor}>{props.model}</text>
        {/* 会话标题：最长 20 列截断（CJK 列宽），避免长标题把模式 chip/右侧提示顶出 */}
        <text fg={theme.textMuted}>
          · 会话 {fitWidth(props.title || DEFAULT_SESSION_TITLE, 20)}
        </text>
        {props.permissionMode ? (
          <text fg={theme.foregroundAccent}>· 模式[{permissionModeLabel(props.permissionMode)}]</text>
        ) : null}
        {props.usage ? (
          <text fg={theme.textMuted}>
            · ↑ {formatTokens(props.usage.inputTokens)} ↓ {formatTokens(props.usage.outputTokens)}
          </text>
        ) : null}
        {/* 命中率段只在确有缓存数据时显示：cacheRead 恒为 0（回落口径无缓存段 / 厂商不报
            cached_tokens）时 0% 与「无数据」不可区分，按无数据处理不渲染 */}
        {props.usage && props.usage.cacheReadTokens > 0 ? (
          <text fg={theme.textMuted}>
            · 缓存 {Math.min(100, Math.round((props.usage.cacheReadTokens / props.usage.inputTokens) * 100))}%
          </text>
        ) : null}
        {/* 水位段：分母经装配层来源链（配置 > 厂商抓取 > 模型目录 > 兜底常量）必可得，
            只看分子是否有数据；到达压缩线（needsCompact 的同一判定值）警示 */}
        {props.contextTokens !== undefined ? (
          <text
            fg={props.compactThreshold !== undefined && props.contextTokens >= props.compactThreshold ? theme.warning : theme.textMuted}
          >
            · 上下文 {Math.min(100, Math.round((props.contextTokens / (props.contextWindow ?? DEFAULT_CONTEXT_WINDOW)) * 100))}%
          </text>
        ) : null}
      </box>
      <text fg={theme.textMuted} flexShrink={0}>
        {props.status === "compacting" ? (
          // 压缩中 Esc 只打断压缩（连按第二次仍按打断压缩处理），提示语不带退出
          <span style={{ fg: theme.running }}>▶ 压缩中（Esc 打断压缩）</span>
        ) : props.status === "running" ? (
          <span style={{ fg: theme.running }}>▶ 运行中（Esc 打断 · 连按两次 Esc 退出）</span>
        ) : (
          <span>
            <span style={{ fg: theme.success }}>● 空闲</span>
            <span style={{ fg: theme.textMuted }}> · ↑↓ 历史 · Ctrl+J 换行</span>
          </span>
        )}
      </text>
    </box>
  );
}
