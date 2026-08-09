import type { Context, Message, StreamEvent } from "../../core/index.js";
import type { TextContent, ThinkingContent, ToolCall, ToolDefinition } from "../../core/index.js";
import type { Protocol } from "../types.js";

interface Choice {
  delta?: {
    content?: string;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string;
}

/** openai-chat-completions 协议：统一格式 ↔ OpenAI 请求体 / 流式响应 */
export class OpenAICompletionsProtocol implements Protocol {
  readonly type = "openai-chat-completions" as const;

  /** 统一 Context → OpenAI 请求体；model 与 stream 参数由 Provider 组装 */
  buildRequest(context: Context): unknown {
    return {
      messages: context.messages.map(toOpenAIMessage),
      ...(context.tools.length > 0 ? { tools: context.tools.map(toOpenAITool) } : {}),
    };
  }

  /**
   * 解析 OpenAI 流式响应，归一化为统一事件。
   * OpenAI 每次返回一个增量片段：可能带文本，也可能带某工具调用的参数片段。
   * 工具调用没有独立的结束标记，这里用 started 记录已开始的调用，
   * 收到 finish_reason 时统一补发结束事件。
   */
  async *parseStream(stream: AsyncIterable<unknown>): AsyncIterable<StreamEvent> {
    const started = new Set<number>();
    for await (const chunk of stream) {
      const choice = firstChoice(chunk);
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.content) {
        yield { type: "text_delta", text: delta.content };
      }

      // 工具调用参数分多次到达：首次带 id / name（标记开始），之后只有参数增量
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (tc.index === undefined) continue;
          if (tc.id && !started.has(tc.index)) {
            yield {
              type: "toolcall_start",
              index: tc.index,
              id: tc.id,
              name: tc.function?.name,
            };
            started.add(tc.index);
          }
          if (tc.function?.arguments) {
            yield { type: "toolcall_delta", index: tc.index, partialJson: tc.function.arguments };
          }
        }
      }

      // 流结束：为所有已开始的工具调用补发结束事件
      if (choice.finish_reason) {
        for (const index of started) {
          yield { type: "toolcall_end", index };
        }
        yield { type: "done", stopReason: choice.finish_reason };
        return;
      }
    }
  }
}

/** 取 chunk 中的第一个 choice（OpenAI 流式通常只有一个），无效 chunk 返回 null */
function firstChoice(chunk: unknown): Choice | null {
  if (typeof chunk !== "object" || chunk === null) return null;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) return null;
  return choice as Choice;
}

/** 统一消息 → OpenAI 消息；assistant 的文本与工具调用拆成两个字段 */
function toOpenAIMessage(message: Message): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "tool_result":
      // 工具结果用 tool 角色，通过 tool_call_id 关联原调用
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    case "assistant": {
      const textBlocks = message.content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => ({ type: "text", text: b.text }));
      // 目标厂商无 thinking 概念，退化为文本
      const thinkingBlocks = message.content
        .filter((b): b is ThinkingContent => b.type === "thinking")
        .map((b) => ({ type: "text", text: `<thinking>${b.thinking}</thinking>` }));
      // 工具调用转成 tool_calls 数组，参数序列化为 JSON 字符串
      const toolCalls = message.content
        .filter((b): b is ToolCall => b.type === "tool_call")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));

      const out: Record<string, unknown> = { role: "assistant" };
      const contentBlocks = [...textBlocks, ...thinkingBlocks];
      if (contentBlocks.length > 0) out.content = contentBlocks;
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      return out;
    }
  }
}

/** 工具定义 → OpenAI function 格式（参数为 JSON Schema） */
function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}
