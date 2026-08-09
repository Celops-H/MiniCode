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

/** openai-chat-completions 协议：统一格式 ↔ OpenAI 请求体 / SSE 流 */
export class OpenAICompletionsProtocol implements Protocol {
  readonly type = "openai-chat-completions" as const;

  /** 统一 Context → OpenAI chat.completions 请求体（不含 model / stream，由 Provider 组装） */
  buildRequest(context: Context): unknown {
    return {
      messages: context.messages.map(toOpenAIMessage),
      ...(context.tools.length > 0 ? { tools: context.tools.map(toOpenAITool) } : {}),
    };
  }

  /** OpenAI SSE chunk → 统一事件流 */
  async *parseStream(stream: AsyncIterable<unknown>): AsyncIterable<StreamEvent> {
    const started = new Set<number>();
    for await (const chunk of stream) {
      const choice = firstChoice(chunk);
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.content) {
        yield { type: "text_delta", text: delta.content };
      }

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

function firstChoice(chunk: unknown): Choice | null {
  if (typeof chunk !== "object" || chunk === null) return null;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) return null;
  return choice as Choice;
}

function toOpenAIMessage(message: Message): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "tool_result":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    case "assistant": {
      const textBlocks = message.content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => ({ type: "text", text: b.text }));
      // 目标厂商无 thinking 概念，退化为文本
      const thinkingBlocks = message.content
        .filter((b): b is ThinkingContent => b.type === "thinking")
        .map((b) => ({ type: "text", text: `<thinking>${b.thinking}</thinking>` }));
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
