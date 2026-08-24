import type { Message } from "../core/index.js";
import { estimateTokens } from "./token.js";

/**
 * 判断错误是否属于「上下文超窗」（DESIGN 9.6 应急压缩的触发条件）：
 * 预判或撞线压缩漏判时，API 直接拒绝请求并返回超窗错误（各家形态不同——
 * Anthropic "prompt is too long"（400）、OpenAI "maximum context length"（400）、
 * Vertex/Bedrock 413）。命中后由上层剥掉最近几组工具回合重发当前轮。
 * @param error 模型调用抛出的错误
 * @returns 是否超窗错误
 */
export function isContextTooLongError(error: unknown): boolean {
  const status = (error as { status?: number } | null | undefined)?.status;
  if (status === 413) return true;
  const message = (error as Error | null | undefined)?.message ?? String(error);
  return /prompt is too long|maximum context length|context_length_exceeded|context length exceeded/i.test(
    message,
  );
}

/**
 * 从超窗错误文本解析「超出量」（actual - limit，token），供剥组时按缺口
 * 一次性剥掉足够多的组，而不是一组一组试。解析不到返回 undefined（退化为剥一组重试）。
 * 两家格式不同：
 * - Anthropic: "prompt is too long: 137500 tokens > 135000 maximum"（actual 在前）
 * - OpenAI: "This model's maximum context length is 128000 tokens. However,
 *   you requested 137500 tokens"（limit 在前）
 * @param error 超窗错误
 * @returns 超出量 token；无法解析返回 undefined
 */
export function parseContextTooLongGap(error: unknown): number | undefined {
  const message = (error as Error | null | undefined)?.message ?? String(error);
  const anthropic = message.match(/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i);
  if (anthropic) {
    const gap = Number(anthropic[1]) - Number(anthropic[2]);
    return gap > 0 ? gap : undefined;
  }
  const openai = message.match(/maximum context length[^0-9]*(\d+)[^0-9]*tokens?[^0-9]*requested[^0-9]*(\d+)/i);
  if (openai) {
    const gap = Number(openai[2]) - Number(openai[1]);
    return gap > 0 ? gap : undefined;
  }
  return undefined;
}

/** 是否含工具调用的 assistant 消息（工具回合的分组起点） */
function hasToolCalls(message: Message): boolean {
  return message.role === "assistant" && message.content.some((block) => block.type === "tool_call");
}

/**
 * 应急剥组（DESIGN 9.6）：从消息尾部剥掉最近几组「工具回合」
 * （assistant 调用与其 tool_result 配对成组、配对不拆，并行调用同组），
 * 让请求变小后由上层重发当前轮，不做摘要。
 * 有 gapTokens 时剥到累计估算 token 覆盖缺口（一次重试到位），否则剥一组。
 * @param messages 当前消息数组
 * @param gapTokens 超出的 token 数（可解析时传入）
 * @returns 剥组后的新数组；无完整组可剥时返回 null（上层放弃重试直接报错）
 */
export function peelToolGroups(messages: Message[], gapTokens?: number): Message[] | null {
  // 从尾部向前扫：每个「assistant 含工具调用」与其后紧跟的 tool_result 段为一组；
  // 游离消息（纯文本 assistant / user，如当前轮的输入）不属于任何组，剥离时保留
  const groups: { start: number; end: number }[] = [];
  let tail = messages.length;
  while (tail > 0 && messages[tail - 1]!.role !== "tool_result") tail--; // 跳过尾部游离消息
  for (let i = tail - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "tool_result") continue; // 属于其前一个 assistant 组
    if (message.role === "assistant" && hasToolCalls(message)) {
      groups.push({ start: i, end: tail });
      tail = i;
    } else {
      tail = i + 1; // 游离消息：组下界拉回其之后
    }
  }
  if (groups.length === 0) return null;

  // 剥组数：按缺口累计，直到覆盖 gap；无 gap 信息时剥最近一组；
  // 剥光全部组仍覆盖不了 gap 时 clamp 到组数（剥完即止）
  let drop = 1;
  if (gapTokens !== undefined) {
    let acc = 0;
    for (const group of groups) {
      acc += estimateTokens(messages.slice(group.start, group.end));
      if (acc >= gapTokens) break;
      drop++;
    }
    drop = Math.min(drop, groups.length);
  }

  // 剥离选中组（按组内 index 移除），游离消息保留
  const remove = new Set<number>();
  for (let k = 0; k < drop; k++) {
    const group = groups[k]!;
    for (let i = group.start; i < group.end; i++) remove.add(i);
  }
  const kept = messages.filter((_, i) => !remove.has(i));
  return kept.length === 0 ? null : kept;
}

