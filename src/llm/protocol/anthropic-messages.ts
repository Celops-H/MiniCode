import type { Context, ContentBlock, Message, ModelUsage, StreamEvent, ToolDefinition } from "../../core/index.js";
import type { ModelInfo, Protocol } from "../types.js";
import { InlineTagFilter, PrefixDeltaGuard } from "./tag-stream.js";

interface AnthropicChunk {
  type?: string;
  index?: number;
  /** text/thinking 块可能把首段内容放在 start 而非 delta（部分兼容端点） */
  content_block?: { type?: string; id?: string; name?: string; text?: string; thinking?: string };
  /** message_start 携带的用量（E63：input_tokens，output_tokens 为流初值） */
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
    /** message_delta 携带的用量（E63：output_tokens 为累计最终值） */
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

/** anthropic-messages 协议：统一格式 ↔ Anthropic 请求体 / 流式响应 */
export class AnthropicMessagesProtocol implements Protocol {
  readonly type = "anthropic-messages" as const;

  /**
   * 统一 Context → Anthropic messages 请求体；model 与 stream 参数由 Provider 组装。
   * @param context 一次模型调用的完整输入
   * @param _model 本次请求的模型定义（Protocol 接口统一签名；anthropic 协议的思考参数
   *   在 Provider 层组装，模型能力位此处不消费）
   * @returns Anthropic messages 请求体（不含 model / stream）
   */
  buildRequest(context: Context, _model?: ModelInfo): unknown {
    return {
      // 系统提示词放顶层 system 字段（Anthropic 约定；空串不占位，厂商拒空 system）
      ...(context.systemPrompt ? { system: context.systemPrompt } : {}),
      messages: toAnthropicMessages(context.messages),
      ...(context.tools.length > 0 ? { tools: context.tools.map(toAnthropicTool) } : {}),
    };
  }

  /**
   * 解析 Anthropic 流式响应，转成统一事件流。
   * tool_use 参数经 input_json_delta 增量到达；content_block 的 index 映射为工具调用序号。
   * 正文增量统一过标签状态机（<thinking>/<tool_call> 标签转回对应事件）与前缀剥离器
   * （累积全文下发的厂商防滚雪球重复），按 content 块生命周期各用一份，见 tag-stream.ts。
   * @param stream Anthropic 原始流式事件对象
   * @returns 统一事件流
   */
  async *parseStream(stream: AsyncIterable<unknown>): AsyncIterable<StreamEvent> {
    const toolIndexByBlock = new Map<number, number>();
    let nextToolIndex = 0;
    let stopReason: string | undefined;
    // 真实用量（E63）：message_start 给 input_tokens（output 为流初值），
    // message_delta 给累计 output_tokens（最终值），随 done 事件挂出
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    // 每个 text/thinking 块各一份清洗状态（块开始新建、块结束 flush），按块 index 取用
    const textGuards = new Map<number, PrefixDeltaGuard>();
    const thinkingGuards = new Map<number, PrefixDeltaGuard>();
    const tagFilters = new Map<number, InlineTagFilter>();
    // 已开始且未 stop 的 text 块（流尾 flush 标签残料用）
    const openTextBlocks = new Set<number>();

    /** 块的正文清洗链：前缀剥离 → 标签状态机 */
    const pushText = (blockIndex: number, text: string): StreamEvent[] => {
      // 登记活跃 text 块：块结束与流尾时要 flush 标签残料（含无首段内容的普通块）
      openTextBlocks.add(blockIndex);
      let guard = textGuards.get(blockIndex);
      if (!guard) {
        guard = new PrefixDeltaGuard();
        textGuards.set(blockIndex, guard);
      }
      let filter = tagFilters.get(blockIndex);
      if (!filter) {
        filter = new InlineTagFilter(() => nextToolIndex++);
        tagFilters.set(blockIndex, filter);
      }
      return filter.push(guard.next(text));
    };

    /** 块的思考清洗链：前缀剥离（思考里不做过标签识别） */
    const pushThinking = (blockIndex: number, thinking: string): StreamEvent[] => {
      let guard = thinkingGuards.get(blockIndex);
      if (!guard) {
        guard = new PrefixDeltaGuard();
        thinkingGuards.set(blockIndex, guard);
      }
      const out = guard.next(thinking);
      return out ? [{ type: "thinking_delta", thinking: out }] : [];
    };

    /** 块结束后释放该块的清洗状态 */
    const releaseBlock = (blockIndex: number): void => {
      textGuards.delete(blockIndex);
      thinkingGuards.delete(blockIndex);
      tagFilters.delete(blockIndex);
      openTextBlocks.delete(blockIndex);
    };

    /** 未 stop 的 text 块 flush 标签残料（正常 message_stop 与异常断流的流尾共用） */
    const flushOpenTextBlocks = function* (): Generator<StreamEvent> {
      for (const blockIndex of openTextBlocks) {
        for (const out of tagFilters.get(blockIndex)?.flush() ?? []) yield out;
      }
    };

    try {
      for await (const chunk of stream) {
        if (typeof chunk !== "object" || chunk === null) continue;
        const event = chunk as AnthropicChunk;

        switch (event.type) {
          case "content_block_start": {
            const block = event.content_block ?? {};
            const blockIndex = event.index ?? -1;
            if (block.type === "tool_use") {
              const toolIndex = nextToolIndex++;
              toolIndexByBlock.set(blockIndex, toolIndex);
              yield {
                type: "toolcall_start",
                index: toolIndex,
                id: block.id,
                name: block.name,
              };
              break;
            }
            // text/thinking 块：start 可能已携带首段内容（部分兼容端点不放 delta）
            if (block.type === "thinking" && block.thinking) {
              for (const out of pushThinking(blockIndex, block.thinking)) yield out;
            } else if (block.text) {
              for (const out of pushText(blockIndex, block.text)) yield out;
            }
            break;
          }
          case "content_block_delta": {
            const delta = event.delta;
            const blockIndex = event.index ?? -1;
            if (delta?.type === "text_delta") {
              // 字段缺失不发空事件（部分兼容端点发空 delta，全空流会产出空内容块）
              if (delta.text) {
                for (const out of pushText(blockIndex, delta.text)) yield out;
              }
            } else if (delta?.type === "thinking_delta") {
              if (delta.thinking) {
                for (const out of pushThinking(blockIndex, delta.thinking)) yield out;
              }
            } else if (delta?.type === "input_json_delta") {
              // 映射不到块 index 的参数增量直接跳过：兜底并到工具 0 会污染它的参数流
              const toolIndex = toolIndexByBlock.get(blockIndex);
              if (toolIndex !== undefined && delta.partial_json) {
                yield { type: "toolcall_delta", index: toolIndex, partialJson: delta.partial_json };
              }
            }
            break;
          }
          case "content_block_stop": {
            const blockIndex = event.index ?? -1;
            const toolIndex = toolIndexByBlock.get(blockIndex);
            if (toolIndex !== undefined) {
              yield { type: "toolcall_end", index: toolIndex };
            }
            if (openTextBlocks.has(blockIndex)) {
              // 块结束：该块的标签残料按原文发出
              for (const out of tagFilters.get(blockIndex)?.flush() ?? []) yield out;
            }
            releaseBlock(blockIndex);
            break;
          }
          case "message_start":
            // 真实用量（E63）：输入 token 在 message_start 的 usage 里
            inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
            outputTokens ??= event.message?.usage?.output_tokens;
            break;
          case "message_delta":
            // Anthropic 的停止原因在 message_delta.delta.stop_reason；仅在有值时覆盖——
            // 个别兼容厂商在带 stop_reason 的 message_delta 后再发只带 usage 的
            // message_delta，无条件覆盖会把已收到的停止原因清掉（E47 收尾判定随之失效）
            stopReason ??= event.delta?.stop_reason;
            // 真实用量（E63）：output_tokens 为累计最终值，最后一次取值
            if (typeof event.delta?.usage?.output_tokens === "number") {
              outputTokens = event.delta.usage.output_tokens;
            }
            break;
          case "message_stop":
            // 兼容端点可能省略 content_block_stop 直接收尾：未 stop 的 text 块残料先 flush 再 done
            yield* flushOpenTextBlocks();
            yield { type: "done", stopReason: stopReason ?? "end_turn", ...anthropicUsage(inputTokens, outputTokens) };
            return;
          case "error":
            yield { type: "error", message: anthropicErrorMessage((chunk as { error?: unknown }).error) };
            return;
          default:
            break;
        }
      }
    } catch (err) {
      // 流中断异常：发 error 事件（观测通道）后原样抛出（控制流，剥组重试等依赖异常）
      yield { type: "error", message: (err as Error).message ?? String(err) };
      throw err;
    }
    // 流尾（断流）：未 stop 的 text 块 flush 标签残料
    yield* flushOpenTextBlocks();
    // 已收到 stop_reason（message_delta 已到，响应逻辑上已完整）：按正常完成收 done。
    // E47 收尾宽限关流场景（厂商发完 message_delta 后握着连接不发 message_stop）落到这里，
    // 整轮不因缺 message_stop 被误判异常
    if (stopReason) {
      yield { type: "done", stopReason, ...anthropicUsage(inputTokens, outputTokens) };
      return;
    }
    // 迭代正常结束且未收到任何停止原因（厂商提前断流）：报 error 标记异常轮
    yield { type: "error", message: "流意外结束（未收到 message_stop）" };
  }
}

/**
 * 统一消息 → Anthropic 消息；工具结果归并进 user 消息（Anthropic 要求）。
 * 完整轮无产出落下的空 assistant（content 为空数组）直接跳过（E55）：与 openai 侧
 * buildRequest 的过滤对称，跨协议切模型续跑不再把它发给严格校验端点吃 400。
 * 跳过（以及错误轮紧跟工具轮等形态）会让历史出现相邻同角色的 user 消息，而严格
 * 校验端点要求角色交替——相邻 user 合并为一条（内容块数组并列，顺序不变），
 * 请求体不再产生相邻同角色消息。
 * @param messages 统一格式消息数组
 * @returns Anthropic 消息参数数组
 */
function toAnthropicMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];

  /** 推入 user 消息；与上一条同为 user 时合并内容块，不产生相邻同角色消息 */
  const pushUser = (content: string | Array<Record<string, unknown>>) => {
    const last = out.at(-1) as { role?: string; content?: unknown } | undefined;
    if (last?.role === "user") {
      const lastBlocks =
        typeof last.content === "string" ? [{ type: "text", text: last.content }] : (last.content as unknown[]);
      const nextBlocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
      last.content = [...lastBlocks, ...nextBlocks];
      return;
    }
    out.push({ role: "user", content });
  };

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      pushUser(pendingToolResults);
      pendingToolResults = [];
    }
  };

  for (const message of messages) {
    switch (message.role) {
      case "user":
        flushToolResults();
        pushUser(message.content);
        break;
      case "assistant":
        if (message.content.length === 0) break;
        flushToolResults();
        out.push({ role: "assistant", content: message.content.map(toAnthropicBlock) });
        break;
      case "tool_result":
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
          is_error: message.isError,
        });
        break;
    }
  }
  flushToolResults();
  return out;
}

/**
 * 内容块 → Anthropic content block。
 * @param block 统一格式内容块（text / thinking / tool_call）
 * @returns Anthropic 内容块对象
 */
function toAnthropicBlock(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      // continuation 需要 signature，统一模型无此字段，退化为文本
      return { type: "text", text: `<thinking>${block.thinking}</thinking>` };
    case "tool_call":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  }
}

/**
 * 工具定义 → Anthropic input_schema 格式。
 * @param tool 工具定义（含参数 JSON Schema）
 * @returns Anthropic tools 数组元素
 */
function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
}

/**
 * 统一用量（E63）：input/output 任一存在才产出 done.usage，缺省不带（厂商未给用量
 * 的流 done 与旧契约一致）。
 * @param inputTokens 输入 token（message_start）
 * @param outputTokens 输出 token（message_delta 累计最终值，回落 message_start 初值）
 * @returns ModelUsage；两者皆缺省返回空对象（展开后不携带 usage 字段）
 */
function anthropicUsage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): { usage?: ModelUsage } {
  if (inputTokens === undefined && outputTokens === undefined) return {};
  return {
    usage: {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    },
  };
}

/**
 * 流内 error 事件的 error 字段 → 可读消息（E96）：官方 overloaded_error 等载荷的
 * error 是对象，String() 直转得 "[object Object]" 并经 assemble 写进持久化 stopReason、
 * 透传界面上屏。对象取 message ?? type，非空字符串直用；空串/0/false 等退化形态与
 * openai 侧同判为占位噪声，报「未知错误」而非「0」「false」这类无信息消息。与 openai
 * 的差异仅在 error 是本协议的终止事件、不能像 openai 的 chunk 噪声那样静默跳过，
 * 故退化形态统一落通用文案。
 * @param error 流内 error 事件的 error 字段值
 * @returns 可读错误消息
 */
function anthropicErrorMessage(error: unknown): string {
  if (typeof error === "string") return error || "未知错误";
  if (typeof error === "object" && error !== null) {
    const fields = error as { message?: unknown; type?: unknown };
    if (typeof fields.message === "string" && fields.message) return fields.message;
    if (typeof fields.type === "string" && fields.type) return fields.type;
    return Object.keys(error).length > 0 ? JSON.stringify(error) : "未知错误";
  }
  return "未知错误";
}
