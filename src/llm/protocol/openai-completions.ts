import type { Context, Message, StreamEvent } from "../../core/index.js";
import type { TextContent, ThinkingContent, ToolCall, ToolDefinition } from "../../core/index.js";
import type { Protocol } from "../types.js";

interface Choice {
  delta?: {
    content?: string;
    /** 推理模型思考增量（DeepSeek 等）→ 统一成 thinking_delta */
    reasoning_content?: string;
    reasoning?: string;
    reasoning_text?: string;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string } | null;
    }>;
  };
  finish_reason?: string;
}

/** openai-chat-completions 协议：统一格式 ↔ OpenAI 请求体 / 流式响应 */
export class OpenAICompletionsProtocol implements Protocol {
  readonly type = "openai-chat-completions" as const;

  /** DeepSeek 等推理厂商：assistant 的 thinking 块回传为 reasoning_content 字段 */
  private readonly reasoningContent: boolean;
  /** 支持 reasoning_effort 请求参数的厂商（仅 OpenAI 系；其余厂商发该字段可能 400，不 emit） */
  private readonly emitReasoningEffort: boolean;

  constructor(options: { reasoningContent?: boolean; emitReasoningEffort?: boolean } = {}) {
    this.reasoningContent = options.reasoningContent ?? false;
    this.emitReasoningEffort = options.emitReasoningEffort ?? false;
  }

  /**
   * 统一 Context → OpenAI 请求体；model 与 stream 参数由 Provider 组装。
   * @param context 一次模型调用的完整输入
   * @returns OpenAI chat.completions 请求体（不含 model / stream）
   */
  buildRequest(context: Context): unknown {
    const converted = context.messages.map((message) => toOpenAIMessage(message, this.reasoningContent));
    return {
      // 系统提示词作为首条 system 消息进请求体（空则不占位，厂商拒空 system）
      messages: context.systemPrompt
        ? [{ role: "system", content: context.systemPrompt }, ...converted]
        : converted,
      ...(context.tools.length > 0 ? { tools: context.tools.map(toOpenAITool) } : {}),
      // 思考等级：仅支持的厂商按用户设定透传 reasoning_effort（@/model 左右调整）
      ...(this.emitReasoningEffort && context.thinkingLevel ? { reasoning_effort: context.thinkingLevel } : {}),
    };
  }

  /**
   * 解析 OpenAI 流式响应，转成统一事件流。
   * OpenAI 每次返回一个增量片段：可能带文本，也可能带某工具调用的参数片段。
   * 工具调用没有独立的结束标记，这里用 started 记录已开始的调用，
   * 收到 finish_reason 时统一补发结束事件。
   * @param stream OpenAI 原始流式 chunk（SSE data 解析后的对象）
   * @returns 统一事件流
   */
  async *parseStream(stream: AsyncIterable<unknown>): AsyncIterable<StreamEvent> {
    const started = new Set<number>();
    // 已发送 start 携带的 id/name（id/name 后补时重复发 start 携带补全值，消费端取最后值）
    const emitted = new Map<number, { id?: string; name?: string }>();
    try {
      for await (const chunk of stream) {
        const choice = firstChoice(chunk);
        if (!choice) continue;

        const delta = choice.delta;
        // 思考增量：多家厂商字段别名（reasoning_content / reasoning / reasoning_text），
        // 取首个非空（同一 chunk 多字段同内容的厂商只发一次，防重复输出）
        const reasoning = delta?.reasoning_content ?? delta?.reasoning ?? delta?.reasoning_text;
        if (reasoning) {
          yield { type: "thinking_delta", thinking: reasoning };
        }
        if (delta?.content) {
          yield { type: "text_delta", text: delta.content };
        }

        // 工具调用参数分多次到达：首次带 id / name（标记开始），之后只有参数增量。
        // 首 chunk 可能无 id（部分厂商先发参数后补 id）：无 id 也发 start（id 可选），
        // 不能只靠 id 判定——否则该调用只有 delta、结束时漏发 end。
        // id/name 后补时重复发 start（assemble 增量更新，接口约定见 core/events.ts）
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (tc.index === undefined) continue;
            if (!started.has(tc.index)) {
              yield {
                type: "toolcall_start",
                index: tc.index,
                id: tc.id,
                name: tc.function?.name ?? undefined,
              };
              started.add(tc.index);
              emitted.set(tc.index, { id: tc.id, name: tc.function?.name ?? undefined });
            } else {
              const sent = emitted.get(tc.index)!;
              const updatedId = tc.id !== undefined && sent.id === undefined ? tc.id : undefined;
              const updatedName = tc.function?.name && sent.name === undefined ? tc.function.name : undefined;
              if (updatedId !== undefined || updatedName !== undefined) {
                yield {
                  type: "toolcall_start",
                  index: tc.index,
                  id: updatedId ?? sent.id,
                  name: updatedName ?? sent.name,
                };
                if (updatedId !== undefined) sent.id = updatedId;
                if (updatedName !== undefined) sent.name = updatedName;
              }
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
    } catch (err) {
      // 流中断异常：发 error 事件（观测通道）后原样抛出（控制流，剥组重试等依赖异常）
      yield { type: "error", message: (err as Error).message ?? String(err) };
      throw err;
    }
    // 迭代正常结束但无 finish_reason（如厂商提前断流）：已开始的调用补发结束，报 error
    for (const index of started) {
      yield { type: "toolcall_end", index };
    }
    yield { type: "error", message: "流意外结束（未收到 finish_reason）" };
  }
}

/**
 * 取 chunk 中的第一个 choice（OpenAI 流式通常只有一个）。
 * @param chunk 一个流式响应片段
 * @returns 第一个 choice；无效 chunk 返回 null
 */
function firstChoice(chunk: unknown): Choice | null {
  if (typeof chunk !== "object" || chunk === null) return null;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) return null;
  return choice as Choice;
}

/**
 * 统一消息 → OpenAI 消息；assistant 的文本与工具调用拆成两个字段。
 * @param message 统一格式消息
 * @param reasoningContent DeepSeek 等推理厂商：thinking 回传为 reasoning_content 字段
 * @returns OpenAI 消息对象
 */
function toOpenAIMessage(message: Message, reasoningContent: boolean): Record<string, unknown> {
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
      const thinkingText = message.content
        .filter((b): b is ThinkingContent => b.type === "thinking")
        .map((b) => b.thinking)
        .join("\n");
      // 工具调用转成 tool_calls 数组，参数序列化为 JSON 字符串
      const toolCalls = message.content
        .filter((b): b is ToolCall => b.type === "tool_call")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));

      const out: Record<string, unknown> = { role: "assistant" };
      const contentBlocks = [...textBlocks];
      // DeepSeek 等推理厂商：上一轮 reasoning_content 必须原样回传（工具调用后下一轮缺了会 400 拒绝），
      // 放到同名字段而不是退化进 content；OpenAI 官方保持退化文本行为。
      // 边界：消息只有 thinking 没有文本/工具调用（如思考中打断收尾落下的半截思考）时退化进 content——
      // 否则请求体是只有 reasoning_content 的 assistant，厂商校验 content/tool_calls 至少一个非空会 400
      // （真机「思考中打断再发消息 400 content or tool_calls must be set」根因）
      if (thinkingText && reasoningContent && (contentBlocks.length > 0 || toolCalls.length > 0)) {
        out.reasoning_content = thinkingText;
      } else if (thinkingText) {
        contentBlocks.push({ type: "text", text: `<thinking>${thinkingText}</thinking>` });
      }
      if (contentBlocks.length > 0) out.content = contentBlocks;
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      return out;
    }
  }
}

/**
 * 工具定义 → OpenAI function 格式。
 * @param tool 工具定义（含参数 JSON Schema）
 * @returns OpenAI tools 数组元素
 */
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
