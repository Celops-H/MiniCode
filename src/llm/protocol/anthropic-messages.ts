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

  /** 统一 Context → Anthropic messages 请求体（不含 model / stream，由 Provider 组装） */
  buildRequest(context: Context): unknown {
    return {
      messages: toAnthropicMessages(context.messages),
      ...(context.tools.length > 0 ? { tools: context.tools.map(toAnthropicTool) } : {}),
    };
  }

  /**
   * 解析 Anthropic 流式响应，归一化为统一事件。
   * tool_use 参数经 input_json_delta 增量到达；content_block 的 index 映射为工具调用序号。
   */
  async *parseStream(stream: AsyncIterable<unknown>): AsyncIterable<StreamEvent> {
    const toolIndexByBlock = new Map<number, number>();
    let nextToolIndex = 0;
    let stopReason: string | undefined;

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
  }
}

/** 统一消息 → Anthropic 消息；工具结果归并进 user 消息 */
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

/** 工具定义 → Anthropic input_schema 格式 */
function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
}
