import type { Context, Message, StreamEvent } from "../../core/index.js";
import type { TextContent, ThinkingContent, ToolCall, ToolDefinition } from "../../core/index.js";
import type { ModelInfo, Protocol } from "../types.js";
import { InlineTagFilter, PrefixDeltaGuard } from "./tag-stream.js";

/** delta 的字段形状（E62 兜底 b：choice.message 同形，delta 缺失时回落读它） */
interface ChoiceDelta {
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
}

interface Choice {
  delta?: ChoiceDelta;
  /** 非真流式厂商把完整 message 字段单 chunk 下发（E62 兜底 b）：字段形状与 delta 一致 */
  message?: ChoiceDelta;
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

/** E68 诊断样本条数上限：只求可辨识，不求全覆盖 */
const DROPPED_SAMPLE_LIMIT = 5;

/** E68 诊断样本单条长度上限（字符） */
const DROPPED_SAMPLE_MAX_LENGTH = 200;

/** openai-chat-completions 协议：统一格式 ↔ OpenAI 请求体 / 流式响应 */
export class OpenAICompletionsProtocol implements Protocol {
  readonly type = "openai-chat-completions" as const;

  /** DeepSeek 等推理厂商：assistant 的 thinking 块回传为 reasoning_content 字段 */
  private readonly reasoningContent: boolean;
  /** 支持 reasoning_effort 请求参数的厂商（OpenAI 系；其余厂商发该字段可能 400，不 emit） */
  private readonly emitReasoningEffort: boolean;
  /** 需显式 enable_thinking 参数才开启思考的厂商（DashScope）：不发送则思考等级静默无效 */
  private readonly enableThinking: boolean;
  /** E68 诊断开关（调试排查用）：记录流解析中未产出任何事件的被丢弃 chunk 样本 */
  private readonly debugDroppedChunks: boolean;

  constructor(
    options: {
      reasoningContent?: boolean;
      emitReasoningEffort?: boolean;
      enableThinking?: boolean;
      debugDroppedChunks?: boolean;
    } = {},
  ) {
    this.reasoningContent = options.reasoningContent ?? false;
    this.emitReasoningEffort = options.emitReasoningEffort ?? false;
    this.enableThinking = options.enableThinking ?? false;
    this.debugDroppedChunks = options.debugDroppedChunks ?? false;
  }

  /**
   * 统一 Context → OpenAI 请求体；model 与 stream 参数由 Provider 组装。
   * 思考类请求参数（reasoning_effort/enable_thinking）仅对推理系列模型（model.reasoning）
   * 随思考等级下发：同一厂商混排思考/非思考模型，对不支持该参数的模型照发会 400（E60）。
   * @param context 一次模型调用的完整输入
   * @param model 本次请求的模型定义（能力位来源），可省略（等价于非推理模型）
   * @returns OpenAI chat.completions 请求体（不含 model / stream）
   */
  buildRequest(context: Context, model?: ModelInfo): unknown {
    // 跳过既无 content 也无 tool_calls 的 assistant：完整轮无任何产出时 runTurn 会落 content:[] 的
    // 空 assistant，续跑把它带给厂商会 400（与 A400 同类残留面）——无信息的消息直接不发更安全
    const converted = context.messages
      .map((message) => toOpenAIMessage(message, this.reasoningContent))
      .filter((m) => !(m.role === "assistant" && m.content == null && m.tool_calls == null));
    const reasoning = model?.reasoning === true;
    return {
      // 系统提示词作为首条 system 消息进请求体（空则不占位，厂商拒空 system）
      messages: context.systemPrompt
        ? [{ role: "system", content: context.systemPrompt }, ...converted]
        : converted,
      ...(context.tools.length > 0 ? { tools: context.tools.map(toOpenAITool) } : {}),
      // 思考等级：支持该参数的厂商对推理系列模型按用户设定透传 reasoning_effort（/model 左右调整）
      ...(this.emitReasoningEffort && reasoning && context.thinkingLevel
        ? { reasoning_effort: context.thinkingLevel }
        : {}),
      // DashScope 等厂商需显式开启思考：仅推理系列模型随思考等级发送
      ...(this.enableThinking && reasoning && context.thinkingLevel ? { enable_thinking: true } : {}),
    };
  }

  /**
   * 解析 OpenAI 流式响应，转成统一事件流。
   * OpenAI 每次返回一个增量片段：可能带文本，也可能带某工具调用的参数片段。
   * 工具调用没有独立的结束标记，收 finish_reason 或流尾时统一补发结束事件。
   * 正文增量统一过标签状态机（<thinking>/<tool_call> 标签转回对应事件）与
   * 前缀剥离器（累积全文下发的厂商防滚雪球重复），见 tag-stream.ts。
   * 逐 chunk 收集事件再统一产出（产出顺序不变）：零产出的 chunk 是 E68 诊断的记录对象，
   * 也是 E56 error 载荷 chunk、E62 message 兜底 chunk 的统一处理位。
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
    // E62 兜底 a)：厂商省略 index 时「有 id 即新调用」用的负数虚拟 index
    // （厂商正常 index 从 0 起，负数空间不撞）；无 id 的续片归并最近打开的调用
    let nextSyntheticVendorIndex = -1;
    let lastOpenedVendorIndex: number | undefined;
    const textGuard = new PrefixDeltaGuard();
    const thinkingGuard = new PrefixDeltaGuard();
    const tagFilter = new InlineTagFilter(() => nextToolIndex++);
    let finishReason: string | undefined;
    // E56：已上报的厂商真实错误（error 载荷），流尾不再补「流意外结束」把真实原因顶掉
    let reportedError: string | undefined;
    // E68 诊断（仅调试开关开启时收集）：被消费却未产出任何事件的 chunk 计数与样本，
    // 流结束（含异常/中断结束）时输出——「流活跃但零输出」的静默卡死复现时有据可查。
    // 无行为改变：不拦截、不报错、不影响任何事件
    const dropped = this.debugDroppedChunks
      ? { total: 0, silent: 0, samples: [] as string[] }
      : undefined;
    try {
      for await (const chunk of stream) {
        if (dropped) dropped.total++;
        const events: StreamEvent[] = [];
        // E56：网关型厂商（one-api 系）在 HTTP 200 的 SSE 里发无 choices、带 error 载荷的
        // chunk——解析出真实错误原因转成统一 error 事件，此前经 firstChoice 直接 continue，
        // 原因丢失、最终只报「流意外结束」
        const chunkError = chunkErrorMessage(chunk);
        if (chunkError) {
          reportedError ??= chunkError;
          events.push({ type: "error", message: chunkError });
        } else {
          const choice = firstChoice(chunk);
          if (choice) {
            // E62 兜底 b)：厂商不支持真流式、把完整 message 字段单 chunk 下发时 delta
            // 缺失，回落读 message（字段形状与 delta 一致），内容不再全丢
            const delta = choice.delta ?? choice.message;
            // 思考增量：多家厂商字段别名（reasoning_content / reasoning / reasoning_text），
            // 取首个非空（同一 chunk 多字段同内容的厂商只发一次，防重复输出）
            const reasoning = delta?.reasoning_content ?? delta?.reasoning ?? delta?.reasoning_text;
            if (reasoning) {
              const thinking = thinkingGuard.next(reasoning);
              if (thinking) events.push({ type: "thinking_delta", thinking });
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
                  if (thinking) events.push({ type: "thinking_delta", thinking });
                  continue;
                }
                // 文本块只认 type 缺省或 text（其他类型块即使带 text 字段也不当正文，防标签泄漏）
                if (block.type !== undefined && block.type !== "text") continue;
                if (!block.text) continue;
                for (const event of tagFilter.push(textGuard.next(block.text))) {
                  events.push(event);
                }
              }
            }

            // 工具调用参数分多次到达：首次带 id / name（标记开始），之后只有参数增量。
            // 首 chunk 可能无 id（部分厂商先发参数后补 id）：无 id 也发 start（id 可选），
            // 不能只靠 id 判定——否则该调用只有 delta、结束时漏发 end。
            // id/name 后补时重复发 start（assemble 增量更新，接口约定见 core/events.ts）
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                // E62 兜底 a)：兼容厂商省略 index 的分组——有 id 优先复用已见过的同 id
                // 调用（厂商省略 index 且每片重发 id 的形态，review 补：否则一条调用被裂成
                // N 条、每条带着截断参数会被真实执行），未见过才开新调用（分配负数虚拟
                // index）；无 id 归并最近打开的调用（流式参数续片）；无 id 且没有已打开的
                // 调用时无处归属，跳过。此前 index 缺失整条调用被直接丢弃，工具调用静默消失
                let vendorIndex = tc.index;
                if (vendorIndex === undefined) {
                  if (tc.id !== undefined) {
                    let seenVendorIndex: number | undefined;
                    for (const [vIdx, tIdx] of indexByVendorIndex) {
                      if (emitted.get(tIdx)?.id === tc.id) {
                        seenVendorIndex = vIdx;
                        break;
                      }
                    }
                    vendorIndex = seenVendorIndex ?? nextSyntheticVendorIndex--;
                  } else if (lastOpenedVendorIndex !== undefined) {
                    vendorIndex = lastOpenedVendorIndex;
                  } else {
                    continue;
                  }
                }
                let toolIndex = indexByVendorIndex.get(vendorIndex);
                if (toolIndex === undefined) {
                  toolIndex = nextToolIndex++;
                  indexByVendorIndex.set(vendorIndex, toolIndex);
                  // 最近打开的调用：无 index 无 id 的后续续片归并到这里
                  lastOpenedVendorIndex = vendorIndex;
                }
                if (!started.has(toolIndex)) {
                  events.push({
                    type: "toolcall_start",
                    index: toolIndex,
                    id: tc.id,
                    name: tc.function?.name ?? undefined,
                  });
                  started.add(toolIndex);
                  openTools.add(toolIndex);
                  emitted.set(toolIndex, { id: tc.id, name: tc.function?.name ?? undefined });
                } else {
                  const sent = emitted.get(toolIndex)!;
                  const updatedId = tc.id !== undefined && sent.id === undefined ? tc.id : undefined;
                  const updatedName = tc.function?.name && sent.name === undefined ? tc.function.name : undefined;
                  if (updatedId !== undefined || updatedName !== undefined) {
                    events.push({
                      type: "toolcall_start",
                      index: toolIndex,
                      id: updatedId ?? sent.id,
                      name: updatedName ?? sent.name,
                    });
                    if (updatedId !== undefined) sent.id = updatedId;
                    if (updatedName !== undefined) sent.name = updatedName;
                  }
                }
                if (tc.function?.arguments) {
                  events.push({ type: "toolcall_delta", index: toolIndex, partialJson: tc.function.arguments });
                }
              }
            }

            // 结束标记：补发已开始工具调用的结束事件，但继续消费到流尾——
            // 个别厂商在 finish_reason 之后还补发正文 chunk，提前 return 会丢内容
            if (choice.finish_reason) {
              finishReason ??= choice.finish_reason;
              for (const index of openTools) {
                events.push({ type: "toolcall_end", index });
              }
              openTools.clear();
            }
          }
        }
        if (dropped && events.length === 0) {
          dropped.silent++;
          if (dropped.samples.length < DROPPED_SAMPLE_LIMIT) {
            dropped.samples.push(droppedChunkSample(chunk));
          }
        }
        yield* events;
      }
    } catch (err) {
      // 流中断异常：发 error 事件（观测通道）后原样抛出（控制流，剥组重试等依赖异常）
      yield { type: "error", message: (err as Error).message ?? String(err) };
      throw err;
    } finally {
      if (dropped && dropped.silent > 0) {
        // 中断/超时等异常收尾也会走到 finally：静默卡死多由用户手动打断才结束，证据不能丢
        process.stderr.write(
          `[minicode:stream-debug] 流解析诊断：本次响应共 ${dropped.total} 个 chunk，其中 ${dropped.silent} 个未产出任何事件；样本：${dropped.samples.join(" | ")}\n`,
        );
      }
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
    // 已上报过厂商真实错误（E56）：不再补「流意外结束」，真实原因不被通用文案顶掉
    if (reportedError) return;
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
 * 取 chunk 携带的 error 载荷消息（E56）：网关型厂商在 HTTP 200 的 SSE 里发
 * {"error":{...}} 或 {"error":"..."} 形态的 chunk，error 可能是对象（取 message）
 * 也可能是字符串本身。null/false/0/空串等退化形态视为占位噪声不当真实错误
 * （维持旧的静默跳过，review 补：报「false」「{}」这类错误事件只会误导）。
 * @param chunk 一个流式响应片段
 * @returns 错误消息；无 error 载荷返回 undefined
 */
function chunkErrorMessage(chunk: unknown): string | undefined {
  if (typeof chunk !== "object" || chunk === null) return undefined;
  const error = (chunk as { error?: unknown }).error;
  if (!error) return undefined;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
    // 无 message 但非空对象（如 {code:1302}）序列化保留错误信号；空对象是噪声
    return Object.keys(error).length > 0 ? JSON.stringify(error) : undefined;
  }
  return String(error);
}

/**
 * E68 诊断样本：被丢弃 chunk 的 JSON 原文，超长截断（样本只求可辨识，不求完整）。
 * @param chunk 一个流式响应片段
 * @returns 截断后的 JSON 文本
 */
function droppedChunkSample(chunk: unknown): string {
  const text = JSON.stringify(chunk) ?? String(chunk);
  return text.length > DROPPED_SAMPLE_MAX_LENGTH
    ? `${text.slice(0, DROPPED_SAMPLE_MAX_LENGTH)}...(len ${text.length})`
    : text;
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
