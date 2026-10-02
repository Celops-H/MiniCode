/**
 * 状态行用量的恢复重建（降级顺序）：
 * 优先扫轨迹（全量含子 agent，LlmCallEnd 逐条归一累计）→ 轨迹不存在回落会话文件
 * meta.usage（仅主 agent、无缓存段）→ 仍无则不显示。工具耗时回填同源：轨迹的
 * PostToolUse 事件按 toolCallId 提取耗时（被中断的调用无 PostToolUse，不显示）。
 */
import type { Message } from "../core/index.js";
import { TraceReader } from "../observability/index.js";
import type { UsageSummary } from "./state.js";

/** 恢复重建结果：用量累计（可能 undefined=无数据显示）与工具耗时回填表 */
export interface UsageRebuild {
  usage?: UsageSummary;
  toolDurations: Map<string, number>;
}

/**
 * 从轨迹重建用量与工具耗时。轨迹文件不存在/读取失败返回无数据的空结果（调用方
 * 回落会话 meta.usage）；轨迹内无任何用量事件同样返回 undefined（旧会话）。
 * @param traceFile 轨迹文件路径（<tracesDir>/<sessionId>.jsonl）
 * @param modelApi 模型 id → 协议（用量归一按协议区分，解析失败按 input 原值的保守口径）
 */
export async function rebuildUsageFromTrace(
  traceFile: string,
  modelApi: (modelId: string) => string | undefined,
): Promise<UsageRebuild> {
  let usage: UsageSummary | undefined;
  const toolDurations = new Map<string, number>();
  try {
    for await (const line of TraceReader.lines(traceFile)) {
      if (line.kind === "message") continue;
      if (line.event === "LlmCallEnd") {
        usage = accumulateTraceUsage(usage, line.data, modelApi);
      } else if (line.event === "PostToolUse") {
        // 被中断的调用没有 PostToolUse 事件（无耗时），天然不进表
        const toolCallId = line.data.toolCallId;
        const durationMs = line.data.durationMs;
        if (typeof toolCallId === "string" && typeof durationMs === "number") {
          toolDurations.set(toolCallId, durationMs);
        }
      } else if (line.event === "PostToolUseFailure") {
        // 执行中失败的调用也带执行窗口耗时；执行前被拒的事件无 durationMs，天然不进表
        const toolCallId = line.data.toolCallId;
        const durationMs = line.data.durationMs;
        if (typeof toolCallId === "string" && typeof durationMs === "number") {
          toolDurations.set(toolCallId, durationMs);
        }
      }
    }
  } catch {
    // 轨迹读取失败（不存在/权限等）：按无轨迹处理，调用方回落
    return { usage: undefined, toolDurations: new Map() };
  }
  return { usage, toolDurations };
}

/** 轨迹 LlmCallEnd 事件行 data 的用量累计（与状态行实时累计同一归一口径） */
function accumulateTraceUsage(
  prev: UsageSummary | undefined,
  data: Record<string, unknown>,
  modelApi: (modelId: string) => string | undefined,
): UsageSummary | undefined {
  const usage = data.usage;
  if (typeof usage !== "object" || usage === null) return prev;
  const u = usage as { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown };
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const anthropicStyle = modelApi(String(data.model ?? "")) === "anthropic-messages";
  const cacheRead = num(u.cacheReadTokens);
  const cacheWrite = num(u.cacheWriteTokens);
  const input = anthropicStyle ? num(u.inputTokens) + cacheRead + cacheWrite : num(u.inputTokens);
  return {
    inputTokens: (prev?.inputTokens ?? 0) + input,
    outputTokens: (prev?.outputTokens ?? 0) + num(u.outputTokens),
    cacheReadTokens: (prev?.cacheReadTokens ?? 0) + cacheRead,
  };
}

/**
 * 回落口径：扫会话消息的 assistant meta.usage 累计（仅主 agent——子 agent 消息不在
 * 会话文件里；无缓存段——缓存命中率不显示）。任何用量都没有时
 * 返回 undefined（状态行不显示用量区）。
 * @param messages 会话消息
 */
export function usageFromMessages(messages: Message[]): UsageSummary | undefined {
  let input = 0;
  let output = 0;
  let seen = false;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const usage = message.meta?.usage;
    if (!usage) continue;
    seen = true;
    input += usage.inputTokens ?? 0;
    output += usage.outputTokens ?? 0;
  }
  return seen ? { inputTokens: input, outputTokens: output, cacheReadTokens: 0 } : undefined;
}
