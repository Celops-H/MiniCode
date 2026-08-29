import type { Context, Message, StreamEvent } from "../../core/index.js";
import type { TextContent, ThinkingContent, ToolCall, ToolDefinition } from "../../core/index.js";
import type { Protocol } from "../types.js";
import { InlineTagFilter, PrefixDeltaGuard } from "./tag-stream.js";

interface Choice {
  delta?: {
    /** 正文文本：OpenAI 标准为字符串；部分兼容厂商（glm 等）发 content 块数组，取文本块拼接（P10） */
    content?: string | Array<ContentArrayBlock>;
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

/** content 块数组的元素：text 块带 text，思考块带思考字段（字段名随厂商而异） */
interface ContentArrayBlock {
  type?: string;
  text?: string;
  thinking?: string;
  reasoning_content?: string;
  reasoning?: string;
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
    // 跳过既无 content 也无 tool_calls 的 assistant：完整轮无任何产出时 runTurn 会落 content:[] 的
    // 空 assistant，续跑把它带给厂商会 400（与 A400 同类残留面）——无信息的消息直接不发更安全
    const converted = context.messages
      .map((message) => toOpenAIMessage(message, this.reasoningContent))
      .filter((m) => !(m.role === "assistant" && m.content == null && m.tool_calls == null));
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
   * 工具调用没有独立的结束标记，收 finish_reason 或流尾时统一补发结束事件。
   * 正文增量统一过标签状态机（<thinking>/<tool_call> 标签转回对应事件）与
   * 前缀剥离器（累积全文下发的厂商防滚雪球重复），见 tag-stream.ts。
   * @param stream OpenAI 原始流式 chunk（SSE data 解析后的对象）
   * @returns 统一事件流
   */
  async *parseStream(stream: AsyncIterable<unknown>): AsyncIterable<StreamEvent> {
    // 厂商 index 只是分组键：统一重编号为顺序序号，与标签工具调用共用同一计数器不撞号
    const indexByVendorIndex = new Map<number, number>();
    // 已发过 start 的统一序号（id/name 后补时重复发 start 携带补全值，消费端取最后值）
    const started = new Set<number>();
    const emitted = new Map<number, { id?: string; name?: string }>();
    // 已开始且未补发结束的工具调用（finish_reason 与流尾各 flush 一次）
    const openTools = new Set<number>();
    let nextToolIndex = 0;
    const textGuard = new PrefixDeltaGuard();
    const thinkingGuard = new PrefixDeltaGuard();
    const tagFilter = new InlineTagFilter(() => nextToolIndex++);
    let finishReason: string | undefined;
    try {
      for await (const chunk of stream) {
        const choice = firstChoice(chunk);
        if (!choice) continue;

        const delta = choice.delta;
        // 思考增量：多家厂商字段别名（reasoning_content / reasoning / reasoning_text），
        // 取首个非空（同一 chunk 多字段同内容的厂商只发一次，防重复输出）
        const reasoning = delta?.reasoning_content ?? delta?.reasoning ?? delta?.reasoning_text;
        if (reasoning) {
          const thinking = thinkingGuard.next(reasoning);
          if (thinking) yield { type: "thinking_delta", thinking };
        }
        if (delta?.content != null) {
          // 正文：字符串当单个文本块；兼容厂商（glm 等）发 content 块数组（P10）——
          // text 块进正文管道，思考块（thinking/reasoning_content/reasoning 字段）进思考
          // 管道（此前被静默丢弃，glm 思考+正文异常的根因之一）
          const blocks =
            typeof delta.content === "string" ? [{ text: delta.content }] : delta.content;
          for (const block of blocks) {
            const blockThinking = block.thinking ?? block.reasoning_content ?? block.reasoning;
            if (blockThinking) {
              const thinking = thinkingGuard.next(blockThinking);
              if (thinking) yield { type: "thinking_delta", thinking };
              continue;
            }
            // 文本块只认 type 缺省或 text（其他类型块即使带 text 字段也不当正文，防标签泄漏）
            if (block.type !== undefined && block.type !== "text") continue;
            if (!block.text) continue;
            for (const event of tagFilter.push(textGuard.next(block.text))) {
              yield event;
            }
          }
        }

        // 工具调用参数分多次到达：首次带 id / name（标记开始），之后只有参数增量。
        // 首 chunk 可能无 id（部分厂商先发参数后补 id）：无 id 也发 start（id 可选），
        // 不能只靠 id 判定——否则该调用只有 delta、结束时漏发 end。
        // id/name 后补时重复发 start（assemble 增量更新，接口约定见 core/events.ts）
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (tc.index === undefined) continue;
            let toolIndex = indexByVendorIndex.get(tc.index);
            if (toolIndex === undefined) {
              toolIndex = nextToolIndex++;
              indexByVendorIndex.set(tc.index, toolIndex);
            }
            if (!started.has(toolIndex)) {
              yield {
                type: "toolcall_start",
                index: toolIndex,
                id: tc.id,
                name: tc.function?.name ?? undefined,
              };
              started.add(toolIndex);
              openTools.add(toolIndex);
              emitted.set(toolIndex, { id: tc.id, name: tc.function?.name ?? undefined });
            } else {
              const sent = emitted.get(toolIndex)!;
              const updatedId = tc.id !== undefined && sent.id === undefined ? tc.id : undefined;
              const updatedName = tc.function?.name && sent.name === undefined ? tc.function.name : undefined;
              if (updatedId !== undefined || updatedName !== undefined) {
                yield {
                  type: "toolcall_start",
                  index: toolIndex,
                  id: updatedId ?? sent.id,
                  name: updatedName ?? sent.name,
                };
                if (updatedId !== undefined) sent.id = updatedId;
                if (updatedName !== undefined) sent.name = updatedName;
              }
            }
            if (tc.function?.arguments) {
              yield { type: "toolcall_delta", index: toolIndex, partialJson: tc.function.arguments };
            }
          }
        }

        // 结束标记：补发已开始工具调用的结束事件，但继续消费到流尾——
        // 个别厂商在 finish_reason 之后还补发正文 chunk，提前 return 会丢内容
        if (choice.finish_reason) {
          finishReason ??= choice.finish_reason;
          for (const index of openTools) {
            yield { type: "toolcall_end", index };
          }
          openTools.clear();
        }
      }
    } catch (err) {
      // 流中断异常：发 error 事件（观测通道）后原样抛出（控制流，剥组重试等依赖异常）
      yield { type: "error", message: (err as Error).message ?? String(err) };
      throw err;
    }
    // 流尾收尾：未闭合的标签残料按原文发出，未结束的工具调用补发结束
    for (const event of tagFilter.flush()) {
      yield event;
    }
    for (const index of openTools) {
      yield { type: "toolcall_end", index };
    }
    if (finishReason) {
      yield { type: "done", stopReason: finishReason };
      return;
    }
    // 流尾无 finish_reason（如厂商提前断流）：已按异常轮收尾，报 error
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
