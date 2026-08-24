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
  isContextTooLongError,
  needsCompact,
  parseContextTooLongGap,
  peelToolGroups,
  pruneToolResults,
  replaceWithSummary,
} from "../context/index.js";
import {
  formatInputError,
  partitionByConcurrency,
  runBatches,
  spillOutput,
  ToolRegistry,
  type ExecuteOutcome,
  type Tool,
} from "../tools/index.js";
import type { PermissionBehavior, PermissionPipeline, PermissionRequest } from "../permission/index.js";
import type { HookBus } from "../hooks/index.js";
import { FileState, withFileState } from "../tools/file-state.js";
import { resolveOutputsDir } from "../config/paths.js";
import { Mailbox, formatMailMessage, type MailMessage } from "./mailbox.js";
import { AgentPath } from "./agent-path.js";
import { createCollaborationTools, COLLAB_TOOL_NAMES, COLLAB_SUBAGENT_PROMPT } from "../tools/index.js";
import type { Team } from "./team.js";

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

/** 超窗应急剥组的最大重试次数（DESIGN 9.6：剥组与重试有上限，超限报错） */
const MAX_CONTEXT_RETRY = 3;

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
  /** 工具输出超限的落盘目录；缺省 `~/.minicode/outputs/`（DESIGN 9.1 ①，测试可注入 tmp 目录） */
  outputDir?: string;
  /** 归属的团队（DESIGN 11.1）：传入即在多 agent 环境注册协作工具，普通单 agent 会话不展示 */
  team?: Team;
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
  /** 本 agent 的文件状态快照（DESIGN 7.6）：read 记录版本、write/edit 校验，多 agent 并行写冲突由它兜底 */
  private readonly fileState = new FileState();
  /** 归属的团队（多 Agent 协作，DESIGN 11.1）；不传则本 agent 独立运行、不展示协作工具 */
  private readonly team?: Team;
  /** 本 agent 在团队中的层级路径（DESIGN 11.1）；注册进团队时由 Team 设置 */
  agentPath?: AgentPath;
  /** 工具输出超限的落盘目录（DESIGN 9.1 ①） */
  private readonly outputDir: string;
  /** agent 邮箱（DESIGN 11.3）：其他 agent 投递的消息队列，注入上下文供模型读取 */
  private readonly mailbox = new Mailbox();
  private messages: Message[] = [];
  /** 摘要压缩失败后置位，停止后续压缩尝试（DESIGN 9.5 失败保护） */
  private compactDisabled = false;
  /** 已执行的 turn 数（与 maxTurns 比较，防失控） */
  private turnCount = 0;
  /** Stop 已触发：run 结束；多 Agent 场景下收件箱来消息可唤醒续跑（DESIGN 11.2） */
  private stopped = false;
  /** 是否有活跃的续跑循环（防重复驱动：忙时投递只入队，活跃循环自行消费，DESIGN 11.2） */
  private active = false;
  /** 是否被中断（interrupt 请求过：停止当前任务，未产出结论，DESIGN 11.4） */
  private interrupted = false;

  constructor(options: AgentOptions) {
    this.modelClient = options.modelClient;
    this.modelId = options.modelId;
    this.systemPrompt = options.systemPrompt;
    this.maxTurns = options.maxTurns ?? 10;
    this.compactConfig = options.compactConfig;
    this.permission = options.permission;
    this.hooks = options.hooks;
    this.outputDir = options.outputDir ?? resolveOutputsDir();
    this.team = options.team;
    this.registry = new ToolRegistry();
    for (const tool of options.tools ?? []) {
      this.registry.register(tool);
    }
    // 多 agent 环境：注册协作工具（DESIGN 11.4，仅团队内可见）
    if (this.team) {
      for (const tool of createCollaborationTools({
        team: this.team,
        getAgentPath: () => this.agentPath,
        createChildAgent: (agentName, path) => this.createChildAgent(agentName, path),
        sendMessage: (target, mail) => this.team!.sendMessage(target, mail),
      })) {
        this.registry.register(tool);
      }
    }
    if (options.initialMessages) {
      this.messages.push(...options.initialMessages);
    }
  }

  /**
   * 创建协作子 agent（DESIGN 11.6 fork_turns=none）：全新上下文 + 运行时继承
   * （模型 / 权限 / Hook / 团队 / 落盘目录），工具 = 父工具集过滤协作工具 + 协作工具。
   * @param agentName 子 agent 名（路径末段，已由 reserveSpawn 校验）
   * @param path 子 agent 在团队中的路径
   * @returns 子 agent 实例（路径已设置，待 commitSpawn 登记）
   */
  private createChildAgent(agentName: string, path: AgentPath): Agent {
    const child = new Agent({
      modelClient: this.modelClient,
      modelId: this.modelId,
      systemPrompt: COLLAB_SUBAGENT_PROMPT,
      tools: this.registry.list().filter((tool) => !COLLAB_TOOL_NAMES.has(tool.name)),
      permission: this.permission,
      hooks: this.hooks,
      team: this.team,
      maxTurns: this.maxTurns,
      outputDir: this.outputDir,
    });
    child.agentPath = path;
    return child;
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
   * 投递消息到本 agent 邮箱（DESIGN 11.3，供 Team 调度投递）。
   * @param mail 消息（类型、发送方、内容、是否唤醒）
   */
  deliver(mail: MailMessage): void {
    this.mailbox.enqueue(mail);
  }

  /** 收件箱是否有未消费消息（调度器 runnable 判定，DESIGN 11.2） */
  hasPendingMail(): boolean {
    return this.mailbox.hasPending();
  }

/**
   * 会话驱动入口（宿主调用，DESIGN 13）：推进 turn 直到会话结束。
   * 会话级 Hook（SessionStart / UserPromptSubmit）由宿主发射——
   * SessionStart 在会话开始（创建后首次驱动前）一次，UserPromptSubmit 在每次用户输入后一次。
   */
  async *run(): AsyncGenerator<StreamEvent> {
    yield* this.resume();
  }

  /**
   * 续跑循环（DESIGN 11.2，供调度器唤醒驱动）：与 run 相同的 turn 推进，但不触发
   * 会话级 Hook（SessionStart / UserPromptSubmit 只属于用户驱动）。
   * 每轮跑完后：收件箱非空（含排队消息）→ 重置续跑预算继续，下一轮 runTurn 消费注入；
   * 收件箱空且终态（模型已回复无工具调用或续跑预算耗尽）→ 结束。
   * 空闲（loop 结束）后的唤醒只由 triggerTurn 消息经 Team 驱动发起。
   * 防重入：已有活跃续跑循环时直接返回（忙时投递只入队，活跃循环在每轮结束自行消费）。
   */
  async *resume(): AsyncGenerator<StreamEvent> {
    if (this.active) return;
    this.active = true;
    try {
      while (true) {
        for await (const event of this.runTurn()) {
          yield event;
        }
        // 收件箱非空（含排队消息）→ 继续 loop：下一轮 runTurn 消费注入（DESIGN 11.2 排队消息不永远滞留）
        if (this.mailbox.hasPending()) {
          this.stopped = false;
          this.turnCount = 0;
          continue;
        }
        // 收件箱空且终态（本轮模型回复无工具调用，或续跑预算耗尽）→ 会话结束
        if (this.stopped || this.turnCount >= this.maxTurns) return;
      }
    } finally {
      this.active = false;
    }
  }

  /** 是否有活跃的续跑循环（调度器判断是否重复驱动） */
  isActive(): boolean {
    return this.active;
  }

  /** 是否被中断（interrupt 置位，通知完成判定用） */
  isInterrupted(): boolean {
    return this.interrupted;
  }

  /**
   * 请求中断（turn 间，DESIGN 11.4）：置 stopped，当前 turn 结束后停止续跑；
   * 收件箱有排队消息时中断不生效（消息视为新任务继续处理）；后续唤醒消息可复活。
   */
  interrupt(): void {
    this.stopped = true;
    this.interrupted = true;
  }

  /** 最后一条 assistant 结论文本（completion watcher 回灌父 agent 用，DESIGN 11.5） */
  conclusionText(): string {
    return lastAssistantText(this.messages);
  }

  /**
   * 执行单个 turn（多 Agent 协作的 turn 级调度单元，DESIGN 11.2）。
   * 每 turn：撞线压缩 → 组装上下文 → 流式调用模型 → 回灌回复 →
   * 无工具调用则置 Stop 结束，否则执行工具调用并回灌结果。
   * 结束（Stop / 达到 maxTurns）后不再产生事件；收件箱消息可在后续注入唤醒续跑。
   * 会话级 Hook（SessionStart / UserPromptSubmit）由宿主发射，本方法保持纯粹。
   */
  async *runTurn(): AsyncGenerator<StreamEvent> {
    if (this.stopped) return;
    if (this.turnCount >= this.maxTurns) return;

    await this.maybeCompact();
    // 消费收件箱消息：注入 source:"system"（消息即上下文，模型直接读文本，DESIGN 11.3）
    if (this.mailbox.hasPending()) {
      for (const mail of this.mailbox.drain()) {
        this.messages.push(userMessage(formatMailMessage(mail), "system"));
      }
    }
    let context = createContext(this.systemPrompt, this.messages, this.registry.definitions());
    const collected: StreamEvent[] = [];
    // 超窗应急剥组重发（DESIGN 9.6）：API 返回超窗错误时剥掉最近几组工具回合后重发当前轮，
    // 不做摘要；剥组与重试有上限，超限直接报错并恢复剥前消息（剥组是重试手段，失败不留副作用）
    const messagesBeforeRetry = this.messages;
    let retryAttempts = 0;
    for (;;) {
      try {
        for await (const event of this.modelClient.stream(this.modelId, context)) {
          collected.push(event);
          yield event;
        }
        break;
      } catch (err) {
        if (!isContextTooLongError(err) || retryAttempts >= MAX_CONTEXT_RETRY) {
          this.messages = messagesBeforeRetry;
          throw err;
        }
        const peeled = peelToolGroups(this.messages, parseContextTooLongGap(err));
        if (!peeled) {
          this.messages = messagesBeforeRetry;
          throw err;
        }
        this.messages = peeled;
        context = createContext(this.systemPrompt, this.messages, this.registry.definitions());
        collected.length = 0;
        retryAttempts++;
      }
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
    // 免审批工具（skipsPermission，如 agent 消息投递）走轻量检查：
    // 跳过规则/缓存/用户审批，保留 plan 只读约束与 PreToolUse hook 拦截（DESIGN 7.1）
    if (this.permission) {
      const rawCommand = call.input.command;
      const request: PermissionRequest = {
        toolName: call.name,
        content: typeof rawCommand === "string" ? rawCommand : undefined,
        input: call.input,
      };
      const hook = this.hooks
        ? (r: PermissionRequest) => this.preToolUseVerdict(r)
        : undefined;
      const result = tool.skipsPermission
        ? await this.permission.checkSkipsPermission(request, hook)
        : await this.permission.check(request, hook);
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
