import {
  assembleAssistantMessage,
  createContext,
  toolCallsOf,
  toolResultMessage,
  userMessage,
  type AssistantMessage,
  type Context,
  type Message,
  type StreamEvent,
  type ToolCall,
  type ToolResultMessage,
} from "../core/index.js";
import {
  buildRecoveryText,
  estimateTokens,
  extractRecoveryContext,
  generateSummary,
  needsCompact,
  pruneToolResults,
  replaceWithSummary,
} from "../context/index.js";
import {
  formatInputError,
  partitionByConcurrency,
  runBatches,
  ToolRegistry,
  truncateOutput,
  type ExecuteOutcome,
  type Tool,
} from "../tools/index.js";

/** 模型客户端：主循环通过它调用模型（Models 集合或测试 mock 均满足） */
export interface ModelClient {
  stream(modelId: string, context: Context): AsyncIterable<StreamEvent>;
}

/** 上下文压缩配置：触发判断的窗口参数与裁剪保留数 */
export interface CompactConfig {
  /** 模型上下文窗口（token） */
  contextWindow: number;
  /** 保留给模型回复输出的 token */
  maxOutputTokens: number;
  /** 安全余量 token */
  safetyMargin: number;
  /** 历史裁剪保留最近的工具结果条数 */
  keepRecentToolResults: number;
}

export interface AgentOptions {
  modelClient: ModelClient;
  modelId: string;
  systemPrompt: string;
  tools?: Tool[];
  /** 初始消息（会话续跑时传入历史），默认为空 */
  initialMessages?: Message[];
  /** 最大轮数，防止失控 */
  maxTurns?: number;
  /** 上下文压缩配置；不传则不做撞线压缩 */
  compactConfig?: CompactConfig;
}

/** Agent 主循环：显式步骤序列，驱动模型对话与工具执行 */
export class Agent {
  private readonly modelClient: ModelClient;
  private readonly modelId: string;
  private readonly systemPrompt: string;
  private readonly maxTurns: number;
  private readonly registry: ToolRegistry;
  private readonly compactConfig?: CompactConfig;
  private messages: Message[] = [];
  /** 摘要压缩失败后置位，停止后续压缩尝试（DESIGN 9.5 失败保护） */
  private compactDisabled = false;

  constructor(options: AgentOptions) {
    this.modelClient = options.modelClient;
    this.modelId = options.modelId;
    this.systemPrompt = options.systemPrompt;
    this.maxTurns = options.maxTurns ?? 10;
    this.compactConfig = options.compactConfig;
    this.registry = new ToolRegistry();
    for (const tool of options.tools ?? []) {
      this.registry.register(tool);
    }
    if (options.initialMessages) {
      this.messages.push(...options.initialMessages);
    }
  }

  /**
   * 追加用户输入，开始新一轮对话。
   * @param input 用户输入内容
   */
  start(input: string): void {
    this.messages.push(userMessage(input));
  }

  /**
   * 获取当前会话全部消息（含历史与新增）。
   * @returns 消息数组的副本，外部修改不影响内部状态
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * 主循环：组装上下文 → 流式调用模型 → 拼装回复 → 无工具调用则结束，
   * 否则串行执行全部工具调用、结果回灌后继续下一轮。
   * 透传模型流事件供外部渲染。
   */
  async *run(): AsyncGenerator<StreamEvent> {
    for (let turn = 0; turn < this.maxTurns; turn++) {
      await this.maybeCompact();
      const context = createContext(this.systemPrompt, this.messages, this.registry.definitions());
      const collected: StreamEvent[] = [];
      for await (const event of this.modelClient.stream(this.modelId, context)) {
        collected.push(event);
        yield event;
      }
      const assistant: AssistantMessage = await assembleAssistantMessage(toAsyncIterable(collected));
      this.messages.push(assistant);

      const calls = toolCallsOf(assistant);
      if (calls.length === 0) {
        return; // 无工具调用，对话结束
      }

      // 并发分区执行：并发安全调用并行、不安全调用串行；结果回灌后模型在下一轮看到
      const batches = partitionByConcurrency(
        calls.map((call, index) => ({ index, isConcurrencySafe: this.isConcurrencySafe(call) })),
      );
      const results: ToolResultMessage[] = new Array(calls.length);
      await runBatches(
        batches,
        async (index) => {
          const outcome = await this.executeTool(calls[index]!);
          results[index] = outcome.message;
          return outcome;
        },
        { onContextModifier: (modifier) => modifier() },
      );
      for (const message of results) {
        this.messages.push(message);
      }
    }
  }

  /**
   * 撞线压缩检查（DESIGN 9 分层）：先历史裁剪（最便宜），仍超限再 LLM 摘要。
   * 摘要压缩失败后置位停止后续尝试（DESIGN 9.5 失败保护）。
   */
  private async maybeCompact(): Promise<void> {
    if (!this.compactConfig || this.compactDisabled) return;
    const tokens = estimateTokens(this.messages);
    if (!needsCompact(tokens, this.compactConfig)) return;

    // ① 历史裁剪：最便宜，先释放旧工具输出；裁剪后仍超限再走摘要
    const pruned = pruneToolResults(this.messages, this.compactConfig.keepRecentToolResults);
    if (pruned !== this.messages) {
      this.messages = pruned;
      if (!needsCompact(estimateTokens(this.messages), this.compactConfig)) return;
    }
    // ② LLM 摘要：撞线前最后一步，用结构化摘要替换旧对话，并注入恢复上下文
    try {
      const recovery = buildRecoveryText(extractRecoveryContext(this.messages));
      const summary = await generateSummary(this.modelClient, this.modelId, this.messages);
      if (summary.trim().length === 0) {
        this.compactDisabled = true;
        return;
      }
      this.messages = replaceWithSummary(summary);
      if (recovery) {
        this.messages.push(userMessage(`【恢复上下文】\n${recovery}`));
      }
    } catch {
      this.compactDisabled = true;
    }
  }

  /**
   * 按具体输入判断调用是否并发安全：工具无判定、参数解析失败或判定抛错 → 保守 false。
   * @param call 工具调用
   * @returns 是否并发安全
   */
  private isConcurrencySafe(call: ToolCall): boolean {
    const tool = this.registry.get(call.name);
    if (!tool?.isConcurrencySafe) return false;
    try {
      const parsed = tool.inputSchema.safeParse(call.input);
      if (!parsed.success) return false;
      return Boolean(tool.isConcurrencySafe(parsed.data));
    } catch {
      return false;
    }
  }

  /**
   * 执行单个工具调用；工具不存在或执行抛错时，以错误消息回灌。
   * 返回工具结果消息与执行产出的上下文修改（供批末统一应用）。
   * @param call 工具调用（含工具名、调用 id 与参数）
   * @returns 工具结果消息与上下文修改
   */
  private async executeTool(call: ToolCall): Promise<ExecuteOutcome & { message: ToolResultMessage }> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      const available = this.registry
        .list()
        .map((t) => t.name)
        .join("、");
      return {
        message: toolResultMessage(
          call.id,
          `未知工具：${call.name}${available ? `，可用工具：${available}` : ""}`,
          true,
        ),
      };
    }
    // 前置参数校验：非法参数格式化为可读错误反馈模型，让其调整后重新调用
    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      return { message: toolResultMessage(call.id, formatInputError(call.name, parsed.error), true) };
    }
    try {
      const result = await tool.execute(call.input);
      const { output, contextModifier, isError } =
        typeof result === "string"
          ? { output: result, contextModifier: undefined, isError: undefined }
          : result;
      const truncated = truncateOutput(output, tool.maxResultSizeChars);
      const finalOutput = truncated.truncated
        ? `${truncated.content}\n[输出已截断：共 ${truncated.originalLength} 字符，保留前 ${truncated.content.length} 字符]`
        : truncated.content;
      return {
        message: toolResultMessage(call.id, finalOutput, isError),
        contextModifier,
      };
    } catch (err) {
      return {
        message: toolResultMessage(
          call.id,
          `工具 ${call.name} 执行失败：${(err as Error).message ?? String(err)}`,
          true,
        ),
      };
    }
  }
}

/**
 * 把数组包装成异步可迭代对象，供需要 AsyncIterable 的接口消费。
 * @param items 待包装的数组
 * @returns 异步可迭代对象
 */
function toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const item of items) yield item;
  })();
}
