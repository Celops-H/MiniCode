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
  type UserMessage,
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
  createSubagentTool,
  formatInputError,
  partitionByConcurrency,
  runBatches,
  spillOutput,
  SUBAGENT_SYSTEM_PROMPT,
  ToolRegistry,
  type ExecuteOutcome,
  type Tool,
} from "../tools/index.js";
import type { PermissionBehavior, PermissionPipeline, PermissionRequest } from "../permission/index.js";
import type { HookBus } from "../hooks/index.js";
import { FileState, withFileState } from "../tools/file-state.js";
import { resolveOutputsDir } from "../config/paths.js";

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
  /** 权限管线；不传则工具执行前不做权限检查（DESIGN 8 权限审批） */
  permission?: PermissionPipeline;
  /** Hook 事件总线；不传则不发射 Hook 事件（DESIGN 13） */
  hooks?: HookBus;
  /** 启用子代理：注册 subagent 工具（DESIGN 10），缺省关闭 */
  subagent?: boolean;
  /** 子代理步数上限，缺省 10（防失控） */
  subagentMaxTurns?: number;
  /** 工具输出超限的落盘目录；缺省 `~/.minicode/outputs/`（DESIGN 9.1 ①，测试可注入 tmp 目录） */
  outputDir?: string;
}

/** Agent 主循环：显式步骤序列，驱动模型对话与工具执行 */
export class Agent {
  private readonly modelClient: ModelClient;
  private readonly modelId: string;
  private readonly systemPrompt: string;
  private readonly maxTurns: number;
  private readonly registry: ToolRegistry;
  private readonly compactConfig?: CompactConfig;
  private readonly permission?: PermissionPipeline;
  private readonly hooks?: HookBus;
  private readonly subagentMaxTurns: number;
  /** 本 agent 的文件状态快照（DESIGN 7.6）：read 记录版本、write/edit 校验，多 agent 并行写冲突由它兜底 */
  private readonly fileState = new FileState();
  /** 工具输出超限的落盘目录（DESIGN 9.1 ①） */
  private readonly outputDir: string;
  private messages: Message[] = [];
  /** 摘要压缩失败后置位，停止后续压缩尝试（DESIGN 9.5 失败保护） */
  private compactDisabled = false;
  /** SessionStart 已触发的标志：只发射一次 */
  private sessionStarted = false;
  /** 已执行的 turn 数（与 maxTurns 比较，防失控） */
  private turnCount = 0;
  /** Stop 已触发：run 结束；多 Agent 场景下收件箱来消息可唤醒续跑（DESIGN 11.2） */
  private stopped = false;

  constructor(options: AgentOptions) {
    this.modelClient = options.modelClient;
    this.modelId = options.modelId;
    this.systemPrompt = options.systemPrompt;
    this.maxTurns = options.maxTurns ?? 10;
    this.compactConfig = options.compactConfig;
    this.permission = options.permission;
    this.hooks = options.hooks;
    this.subagentMaxTurns = options.subagentMaxTurns ?? 10;
    this.outputDir = options.outputDir ?? resolveOutputsDir();
    this.registry = new ToolRegistry();
    for (const tool of options.tools ?? []) {
      this.registry.register(tool);
    }
    // 启用子代理时注册 subagent 工具，执行时创建独立上下文的子 Agent（DESIGN 10）
    if (options.subagent) {
      this.registry.register(
        createSubagentTool({ runSubagent: (prompt) => this.runSubagent(prompt) }),
      );
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
    // 新一轮用户输入到来：重置 Stop 与 turnCount，允许再次跑 turn（DESIGN 11.2 单次续跑上限）
    this.stopped = false;
    this.turnCount = 0;
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
   * 主循环：逐个 turn 执行直到结束（Stop 或达到 maxTurns），透传模型流事件供外部渲染。
   * 底层由 runTurn 驱动，保留多 Agent 协作所需的 turn 粒度（DESIGN 11.2）。
   */
  async *run(): AsyncGenerator<StreamEvent> {
    // 会话级 Hook 收拢在 run（驱动入口）：
    // SessionStart 整个 agent 生命周期只发一次；UserPromptSubmit 每次 run 处理用户输入前发一次
    if (!this.sessionStarted) {
      this.sessionStarted = true;
      await this.hooks?.emit({ type: "SessionStart" });
    }
    const lastUser = [...this.messages].reverse().find(
      (message): message is UserMessage =>
        message.role === "user" && message.source !== "system",
    );
    if (lastUser) {
      await this.hooks?.emit({ type: "UserPromptSubmit", input: lastUser.content });
    }
    while (true) {
      let yielded = false;
      for await (const event of this.runTurn()) {
        yielded = true;
        yield event;
      }
      // runTurn 不产出事件（已结束或无可执行 turn）→ 会话结束
      if (!yielded) return;
    }
  }

  /**
   * 执行单个 turn（多 Agent 协作的 turn 级调度单元，DESIGN 11.2）。
   * 每 turn：撞线压缩 → 组装上下文 → 流式调用模型 → 回灌回复 →
   * 无工具调用则置 Stop 结束，否则执行工具调用并回灌结果。
   * 结束（Stop / 达到 maxTurns）后不再产生事件；收件箱消息可在后续注入唤醒续跑。
   * 会话级 Hook（SessionStart / UserPromptSubmit）由 run 触发，本方法保持纯粹。
   */
  async *runTurn(): AsyncGenerator<StreamEvent> {
    if (this.stopped) return;
    if (this.turnCount >= this.maxTurns) return;

    await this.maybeCompact();
    const context = createContext(this.systemPrompt, this.messages, this.registry.definitions());
    const collected: StreamEvent[] = [];
    for await (const event of this.modelClient.stream(this.modelId, context)) {
      collected.push(event);
      yield event;
    }
    const assistant: AssistantMessage = await assembleAssistantMessage(toAsyncIterable(collected));
    this.messages.push(assistant);
    this.turnCount++;

    const calls = toolCallsOf(assistant);
    if (calls.length === 0) {
      // Stop：模型回复无工具调用，本轮对话准备结束
      this.stopped = true;
      await this.hooks?.emit({ type: "Stop" });
      return;
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
        // 恢复上下文由系统注入而非用户输入，标记 source: "system"
        this.messages.push(userMessage(`【恢复上下文】\n${recovery}`, "system"));
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
          call.name,
          `未知工具：${call.name}${available ? `，可用工具：${available}` : ""}`,
          true,
        ),
      };
    }
    // 前置参数校验：非法参数格式化为可读错误反馈模型，让其调整后重新调用
    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      return { message: toolResultMessage(call.id, call.name, formatInputError(call.name, parsed.error), true) };
    }
    // 权限审批：被拒则回灌错误消息、不执行工具，模型据此调整方案
    if (this.permission) {
      const rawCommand = call.input.command;
      const result = await this.permission.check(
        {
          toolName: call.name,
          content: typeof rawCommand === "string" ? rawCommand : undefined,
          input: call.input,
        },
        // 接入 PreToolUse Hook 事件（DESIGN 8.1：规则层 ask 时进决策链）
        this.hooks ? (request) => this.preToolUseVerdict(request) : undefined,
      );
      if (!result.allowed) {
        return {
          message: toolResultMessage(call.id, call.name, `权限拒绝：${result.reason ?? "未授权"}`, true),
        };
      }
    }
    try {
      const result = await withFileState(this.fileState, () => tool.execute(call.input));
      const { output, contextModifier, isError } =
        typeof result === "string"
          ? { output: result, contextModifier: undefined, isError: undefined }
          : result;
      const truncated = spillOutput(output, tool.maxResultSizeChars, this.outputDir);
      const finalOutput = truncated.content;
      // PostToolUse：工具执行完成（含标记失败的结果），供观测
      await this.hooks?.emit({
        type: "PostToolUse",
        toolName: call.name,
        input: call.input,
        output: finalOutput,
        isError: Boolean(isError),
      });
      return {
        message: toolResultMessage(call.id, call.name, finalOutput, isError),
        contextModifier,
      };
    } catch (err) {
      const error = (err as Error).message ?? String(err);
      // PostToolUseFailure：工具执行抛错，供观测
      await this.hooks?.emit({
        type: "PostToolUseFailure",
        toolName: call.name,
        input: call.input,
        error,
      });
      return {
        message: toolResultMessage(call.id, call.name, `工具 ${call.name} 执行失败：${error}`, true),
      };
    }
  }

  /**
   * PreToolUse Hook 裁决：触发事件总线，多个 hook 结果聚合为 deny 优先于 ask 优先于 allow
   * （DESIGN 8.1 第一个反对即停）；无 hook 返回 undefined，继续走用户审批。
   * @param request 权限请求（含工具名与完整参数）
   * @returns 裁决；无任何 hook 响应时返回 undefined
   */
  private async preToolUseVerdict(
    request: PermissionRequest,
  ): Promise<PermissionBehavior | undefined> {
    const results = await this.hooks?.emit({
      type: "PreToolUse",
      toolName: request.toolName,
      input: request.input ?? {},
    });
    if (results?.includes("deny")) return "deny";
    if (results?.includes("ask")) return "ask";
    if (results?.includes("allow")) return "allow";
    return undefined;
  }

  /**
   * 执行子代理：创建独立上下文的新 Agent 实例，只回传结论文本（DESIGN 10）。
   * 子代理不继承父历史（只含任务描述），中间过程不进入父上下文。
   * 递归防护（DESIGN 10.3）：子代理工具集去掉 subagent 自身，物理上无法再派生子代理。
   * @param prompt 子任务描述
   * @returns 子代理最后一条 assistant 文本结论
   */
  private async runSubagent(prompt: string): Promise<string> {
    const subagent = new Agent({
      modelClient: this.modelClient,
      modelId: this.modelId,
      systemPrompt: SUBAGENT_SYSTEM_PROMPT,
      tools: this.registry.list().filter((tool) => tool.name !== "subagent"),
      maxTurns: this.subagentMaxTurns,
      // 权限继承（DESIGN 10.3 bubble）：复用父管线，子代理的规则/模式/审批/缓存冒泡到父会话
      permission: this.permission,
    });
    subagent.start(prompt);
    for await (const _ of subagent.run()) {
      // 消费子代理事件流
    }
    return lastAssistantText(subagent.getMessages());
  }
}

/**
 * 从消息末尾向前找第一条含文本的 assistant 消息，返回其文本内容。
 * @param messages 消息数组
 * @returns 文本结论；找不到时返回占位说明
 */
function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.trim()) return text;
  }
  return "(子代理未产出结论)";
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
