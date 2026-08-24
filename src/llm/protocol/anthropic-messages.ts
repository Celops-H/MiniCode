import type { Context, ContentBlock, Message, StreamEvent, ToolDefinition } from "../../core/index.js";
import type { Protocol } from "../types.js";

interface AnthropicChunk {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
}

/** anthropic-messages 协议：统一格式 ↔ Anthropic 请求体 / 流式响应 */
export class AnthropicMessagesProtocol implements Protocol {
  readonly type = "anthropic-messages" as const;

  /**
   * 统一 Context → Anthropic messages 请求体；model 与 stream 参数由 Provider 组装。
   * @param context 一次模型调用的完整输入
   * @returns Anthropic messages 请求体（不含 model / stream）
   */
  buildRequest(context: Context): unknown {
    return {
      messages: toAnthropicMessages(context.messages),
      ...(context.tools.length > 0 ? { tools: context.tools.map(toAnthropicTool) } : {}),
    };
  }

  /**
   * 解析 Anthropic 流式响应，转成统一事件流。
   * tool_use 参数经 input_json_delta 增量到达；content_block 的 index 映射为工具调用序号。
   * @param stream Anthropic 原始流式事件对象
   * @returns 统一事件流
   */
  async *parseStream(stream: AsyncIterable<unknown>): AsyncIterable<StreamEvent> {
    const toolIndexByBlock = new Map<number, number>();
    let nextToolIndex = 0;
    let stopReason: string | undefined;

    try {
      for await (const chunk of stream) {
        if (typeof chunk !== "object" || chunk === null) continue;
        const event = chunk as AnthropicChunk;

        switch (event.type) {
          case "content_block_start": {
            const block = event.content_block;
            if (block?.type === "tool_use") {
              const toolIndex = nextToolIndex++;
              toolIndexByBlock.set(event.index ?? -1, toolIndex);
              yield {
                type: "toolcall_start",
                index: toolIndex,
                id: block.id,
                name: block.name,
              };
            }
            break;
          }
          case "content_block_delta": {
            const delta = event.delta;
            if (delta?.type === "text_delta") {
              yield { type: "text_delta", text: delta.text ?? "" };
            } else if (delta?.type === "thinking_delta") {
              yield { type: "thinking_delta", thinking: delta.thinking ?? "" };
            } else if (delta?.type === "input_json_delta") {
              const toolIndex = toolIndexByBlock.get(event.index ?? -1) ?? 0;
              yield { type: "toolcall_delta", index: toolIndex, partialJson: delta.partial_json ?? "" };
            }
            break;
          }
          case "content_block_stop": {
            const toolIndex = toolIndexByBlock.get(event.index ?? -1);
            if (toolIndex !== undefined) {
              yield { type: "toolcall_end", index: toolIndex };
            }
            break;
          }
          case "message_delta":
            // Anthropic 的停止原因在 message_delta.delta.stop_reason
            stopReason = event.delta?.stop_reason;
            break;
          case "message_stop":
            yield { type: "done", stopReason: stopReason ?? "end_turn" };
            return;
          case "error":
            yield { type: "error", message: String((chunk as { error?: unknown }).error ?? "未知错误") };
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
  }
}

/**
 * 统一消息 → Anthropic 消息；工具结果归并进 user 消息（Anthropic 要求）。
 * @param messages 统一格式消息数组
 * @returns Anthropic 消息参数数组
 */
function toAnthropicMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      out.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const message of messages) {
    switch (message.role) {
      case "user":
        flushToolResults();
        out.push({ role: "user", content: message.content });
        break;
      case "assistant":
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
