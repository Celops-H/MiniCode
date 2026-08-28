import {
  assembleAssistantMessage,
  createContext,
  type ThinkingLevel,
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
  RECOVERY_MARKER,
  replaceWithSummary,
  SUMMARY_MARKER,
  updateMemory,
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
import type { HookBus, HookEvent } from "../hooks/index.js";
import { FileState, withCwd, withFileState } from "../tools/file-state.js";
import { resolveOutputsDir } from "../config/paths.js";
import { Mailbox, formatMailMessage, type MailMessage } from "./mailbox.js";
import { AgentPath } from "./agent-path.js";
import { createCollaborationTools, COLLAB_TOOL_NAMES, COLLAB_SUBAGENT_PROMPT } from "../tools/index.js";
import type { Team } from "./team.js";

/** 模型客户端：主循环通过它调用模型（Models 集合或测试 mock 均满足） */
export interface ModelClient {
  stream(modelId: string, context: Context, options?: { signal?: AbortSignal }): AsyncIterable<StreamEvent>;
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

/** 会话记忆文本上限（DESIGN 9.7：防无限膨胀，超出截断） */
const MAX_MEMORY_CHARS = 4000;

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
  /** Hook 事件总线；不传则不触发 Hook 事件（DESIGN 13） */
  hooks?: HookBus;
  /** 工具输出超限的落盘目录；缺省 `~/.minicode/outputs/`（DESIGN 9.1 ①，测试可注入 tmp 目录） */
  outputDir?: string;
  /** 思考等级活引用（\`/@/model 左右调整实时生效\`）：每轮组装 Context 时读一次，透传 reasoning_effort（仅支持的厂商） */
  thinkingLevelRef?: () => ThinkingLevel | undefined;
  /** 工具执行的工作目录（相对路径解析基准，DESIGN 4.2）；缺省进程 cwd */
  cwd?: string;
  /**
   * checkpoint 回调（DESIGN 14）：每批工具执行前调用，传入当前全部消息——
   * 宿主在此把已产生的消息（用户输入 + 模型回复含工具调用）落盘，
   * 工具副作用不可逆，执行前崩溃时历史在盘上可恢复续跑
   */
  checkpoint?: (messages: Message[]) => Promise<void> | void;
  /** 启用会话记忆（DESIGN 9.7）：每轮结束后模型增量维护记忆，压缩时用记忆替代现场摘要省模型调用 */
  memory?: boolean;
  /** 只读快工具正常执行超时（ms）：glob/read/grep 等本应秒回，异常挂起时兜底强制失败；默认 10s */
  toolTimeoutMs?: number;
  /** 归属的团队（DESIGN 11.1）：传入即在多 agent 环境注册协作工具，普通单 agent 会话不展示 */
  team?: Team;
}

/** Agent 主循环：显式步骤序列，驱动模型对话与工具执行 */
export class Agent {
  private readonly modelClient: ModelClient;
  private readonly modelId: string;
  private readonly systemPrompt: string;
  private readonly maxTurns: number;
  /** 只读快工具正常执行超时（ms） */
  private readonly toolTimeoutMs: number;
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
  /** 工具执行的工作目录（相对路径解析基准，DESIGN 4.2） */
  private readonly cwd: string;
  /** checkpoint 回调（DESIGN 14）：工具执行前宿主落盘用 */
  private readonly checkpoint?: (messages: Message[]) => Promise<void> | void;
  /** 会话记忆是否启用（DESIGN 9.7） */
  private readonly memoryEnabled: boolean;
  /** 会话记忆文本（模型持续维护的关键信息，压缩时替代现场摘要） */
  private memory = "";
  /** 记忆已覆盖的消息数（上次记忆更新时）：压缩时其后的消息为「在途」，保留原文不丢 */
  private memoryCovered = 0;
  /** agent 邮箱（DESIGN 11.3）：其他 agent 投递的消息队列，注入上下文供模型读取 */
  private readonly mailbox = new Mailbox();
  private messages: Message[] = [];
  /** 摘要压缩失败后置位，停止后续压缩尝试（DESIGN 9.5 失败保护） */
  private compactDisabled = false;
  /** 历史被改写标记（压缩/裁剪/超窗剥组改过已落盘消息）：宿主据此重写持久化，防落盘与内存错位 */
  private historyRewritten = false;
  /** 已执行的 turn 数（与 maxTurns 比较，防失控） */
  private turnCount = 0;
  /** Stop 已触发：run 结束；多 Agent 场景下收件箱来消息可唤醒续跑（DESIGN 11.2） */
  private stopped = false;
  /** 是否有活跃的续跑循环（防重复驱动：忙时投递只入队，活跃循环自行消费，DESIGN 11.2） */
  private active = false;
  /** 是否被中断（interrupt 请求过：停止当前任务，未产出结论，DESIGN 11.4） */
  private interrupted = false;
  /** 当前轮的中断信号（turn 内真打断）：interrupt 中止进行中的模型流/工具执行；start 新建复位 */
  private interruptController = new AbortController();
  /** 思考等级活引用（每轮组装 Context 时读一次；undefined=用厂商默认） */
  private readonly thinkingLevelRef?: () => ThinkingLevel | undefined;

  constructor(options: AgentOptions) {
    this.modelClient = options.modelClient;
    this.modelId = options.modelId;
    this.systemPrompt = options.systemPrompt;
    this.thinkingLevelRef = options.thinkingLevelRef;
    this.maxTurns = options.maxTurns ?? 10;
    this.toolTimeoutMs = options.toolTimeoutMs ?? TOOL_READONLY_TIMEOUT_MS;
    this.compactConfig = options.compactConfig;
    this.permission = options.permission;
    this.hooks = options.hooks;
    this.outputDir = options.outputDir ?? resolveOutputsDir();
    this.cwd = options.cwd ?? process.cwd();
    this.team = options.team;
    this.checkpoint = options.checkpoint;
    this.memoryEnabled = options.memory ?? false;
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
      // checkpoint 崩溃恢复（DESIGN 14）：末尾可能残留「工具调用无结果」的孤儿状态——
      // 工具执行前已落盘但结果未及写盘。补失败结果保持配对完整（续跑不 400），
      // 模型看到「执行中断」自行决定重试或调整（比剥掉调用保留上下文）
      this.messages.push(...repairOrphanToolCalls(options.initialMessages));
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
    // Git Worktree 隔离（DESIGN 4.2）：worktrees 开启且父在 git 仓库内时，
    // 子 agent 绑定独立工作区（cwd），文件写与父物理隔离；非 git 仓库继承父 cwd
    const worktree = this.team?.createChildWorktree(path.parent(), agentName);
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
      cwd: worktree?.dir ?? this.cwd,
      // 思考等级随父继承（会话级偏好，子 agent 与 root 一致）
      thinkingLevelRef: this.thinkingLevelRef,
    });
    child.agentPath = path;
    return child;
  }

  /**
   * 追加用户输入，开始新一轮对话。
   * @param input 用户输入内容
   */
  start(input: string): void {
    // 新一轮用户输入到来：重置 Stop 与 turnCount，允许再次跑 turn（DESIGN 11.2 单次续跑上限）；
    // 同步复位中断状态（新对话 = 新的生命周期，上一轮中断作废，结论可正常回灌），
    // 并新建中断信号（上一轮的 abort 不作用于新对话）
    this.stopped = false;
    this.turnCount = 0;
    this.interrupted = false;
    this.interruptController = new AbortController();
    this.messages.push(userMessage(input));
  }

  /**
   * 获取当前会话全部消息（含历史与新增）。
   * @returns 消息数组的副本，外部修改不影响内部状态
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /** 清空消息历史（TUI /clear 回会话新建态用）：会话消息清盘后 agent 上下文同步清空，
   *  防下一轮 start() 把旧历史连同新输入一起回灌模型并重写会话文件 */
  resetHistory(): void {
    this.messages = [];
  }

  /** 工具执行的工作目录（相对路径解析基准，DESIGN 4.2；Team 创建 worktree 时读取） */
  getCwd(): string {
    return this.cwd;
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

  /** 清空收件箱（Team 会话收尾调用）：排队消息会让中断的 agent 在 resume 里复活续跑——
   *  重新拉起模型流吊住进程（M1 整体审视，对齐 A-4 退出清理目标） */
  clearMailbox(): void {
    this.mailbox.drain();
  }

/**
   * 会话驱动入口（宿主调用，DESIGN 13）：推进 turn 直到会话结束。
   * 会话级 Hook（SessionStart / UserPromptSubmit）由宿主触发——
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
    // 复活（新一轮驱动，DESIGN 11.2 中断后可复活）：复位中断状态——
    // 上一轮 interrupt 置位只影响当时的 notifyCompletion 判定，新一轮结论应正常回灌父；
    // 同步新建中断信号，上一轮的 abort 不作用于新一轮
    this.interrupted = false;
    this.interruptController = new AbortController();
    try {
      while (true) {
        for await (const event of this.runTurn()) {
          yield event;
        }
        // 收件箱非空（含排队消息）→ 继续 loop：下一轮 runTurn 消费注入（DESIGN 11.2 排队消息不永远滞留）
        if (this.mailbox.hasPending()) {
          this.stopped = false;
          this.turnCount = 0;
          // 轮间继续 = 新任务：中断状态一并复位（review 修复：原实现只入口复位，
          // interrupt 落活跃循环中途 + 排队消息继续时，新任务结论仍被 notifyCompletion 吞掉）
          this.interrupted = false;
          this.interruptController = new AbortController();
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
   * 请求中断（turn 内真打断）：置 stopped，并中止当前轮进行中的模型流/工具执行——
   * runTurn 收到中止信号后收尾（本轮已产出保留、未执行工具补失败结果）尽快返回；
   * 收件箱有排队消息时中断不生效（消息视为新任务继续处理）；
   * 后续唤醒消息可复活（新一轮 resume/start 时复位 interrupted 与中断信号，结论恢复回灌）。
   */
  interrupt(): void {
    this.interruptController.abort();
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
   * 会话级 Hook（SessionStart / UserPromptSubmit）由宿主触发，本方法保持纯粹。
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
    let context = createContext(this.systemPrompt, this.messages, this.registry.definitions(), this.thinkingLevelRef?.());
    const collected: StreamEvent[] = [];
    // 超窗应急剥组重发（DESIGN 9.6）：API 返回超窗错误时剥掉最近几组工具回合后重发当前轮，
    // 不做摘要；剥组与重试有上限，超限直接报错并恢复剥前消息（剥组是重试手段，失败不留副作用）
    const messagesBeforeRetry = this.messages;
    let retryAttempts = 0;
    for (;;) {
      try {
        for await (const event of withInterruptTimeout(
          this.modelClient.stream(this.modelId, context, { signal: this.interruptController.signal }),
          this.interruptController.signal,
          INTERRUPT_STREAM_TIMEOUT_MS,
        )) {
          // 中断引发的流错误统一到 error 事件，不向宿主转发（interrupt 语义已覆盖，宿主不见「中断=错误」）
          if (this.interruptController.signal.aborted && event.type === "error") continue;
          // 观察事件（模型路由切换提示）只透传宿主观测，不进 collected——否则 assemble 会把
          // 它的长度误算为「已产出」（中断收尾以 collected.length 判断要不要落半截回复）
          if (event.type !== "model_fallback") collected.push(event);
          yield event;
        }
        break;
      } catch (err) {
        // 中断：跳出重试循环，走已产出保留收尾（不由超窗剥组重发）
        if (this.interruptController.signal.aborted) break;
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
        this.historyRewritten = true; // 已落盘的工具回合被剥除
        context = createContext(this.systemPrompt, this.messages, this.registry.definitions(), this.thinkingLevelRef?.());
        collected.length = 0;
        retryAttempts++;
      }
    }
    const assistant: AssistantMessage = await assembleAssistantMessage(toAsyncIterable(collected));
    // 中断收尾（turn 内真打断）：已产出的文本/思考保留为 assistant；含但未执行的工具调用
    // 补失败结果保持配对闭合（续跑不 400，模型看到「执行中断」自行决定重试或调整）；
    // 完全没收到内容则连空消息也不落。中断后本轮结束，已产出留在历史、可正常续跑。
    if (this.interruptController.signal.aborted) {
      if (collected.length > 0) {
        this.messages.push(assistant);
        for (const call of toolCallsOf(assistant)) {
          this.messages.push(
            toolResultMessage(call.id, call.name, "执行中断：用户打断，工具未执行", true),
          );
        }
      }
      this.stopped = true;
      return;
    }
    this.messages.push(assistant);
    this.turnCount++;

    const calls = toolCallsOf(assistant);
    if (calls.length === 0) {
      // Stop：模型回复无工具调用，本轮对话准备结束。
      // 带 agentPath（多 agent 下区分「谁」空闲）：TUI 据此只把主 agent 的 Stop 视为回合空闲
      //（子 agent 轮次结束不应把主界面打成空闲，P8）
      this.stopped = true;
      await this.safeEmit({ type: "Stop", agentPath: this.agentPath?.toString() ?? "/root" });
      // 会话记忆（DESIGN 9.7）：每轮结束后增量维护记忆，压缩时用记忆替代现场摘要省模型调用
      if (this.memoryEnabled) {
        await this.maybeUpdateMemory();
      }
      return;
    }

    // checkpoint（DESIGN 14）：工具副作用不可逆，执行前让宿主把本轮已产生的
    // 消息（用户输入 + 含工具调用的回复）落盘，崩溃时历史可恢复续跑
    await this.checkpoint?.(this.messages);

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
   * 增量维护会话记忆（DESIGN 9.7）：用模型把当前记忆 + 最近对话合入更新后的记忆。
   * 失败静默（记忆不更新，不影响主流程）；记忆文本限制长度防无限膨胀。
   */
  private async maybeUpdateMemory(): Promise<void> {
    try {
      const updated = await updateMemory(
        this.modelClient,
        this.modelId,
        {
          currentMemory: this.memory,
          recentMessages: this.messages,
        },
        this.interruptController.signal,
      );
      if (updated.trim().length > 0) {
        this.memory = updated.trim().slice(0, MAX_MEMORY_CHARS);
        this.memoryCovered = this.messages.length; // 当前全部消息已入记忆
      }
    } catch {
      // 记忆更新失败不影响对话主流程
    }
  }

  /**
   * 撞线压缩检查（DESIGN 9 分层）：先历史裁剪（最便宜），仍超限再 LLM 摘要。
   * 摘要压缩失败后置位停止后续尝试（DESIGN 9.5 失败保护）。
   */
  private async maybeCompact(): Promise<void> {
    if (!this.compactConfig || this.compactDisabled) return;
    if (!needsCompact(estimateTokens(this.messages), this.compactConfig)) return;
    await this.doCompact();
  }

  /**
   * 用户主动压缩（/compact，DESIGN 15）：无视撞线判断强制走分层压缩
   * （裁剪旧工具输出 → 摘要替换），返回是否发生压缩（供宿主反馈）。
   * 带压缩指导时（DESIGN 9.8）跳过会话记忆替代路径、改走现场摘要——记忆是现成
   * 文本，指导无从生效；无指导保留记忆替代省调用路径。
   * 显式请求可绕过 compactDisabled 失败保护重试（撞线自动压缩仍受保护）。
   * 压缩替换消息后，宿主需把新消息落盘并与持久化游标联动。
   * @param instructions 压缩指导（可省略）：以 Additional Instructions 段追加摘要提示词末尾
   * @returns 是否成功压缩（未配置压缩或摘要失败时 false）
   */
  async compactNow(instructions?: string): Promise<boolean> {
    if (!this.compactConfig) return false;
    return this.doCompact(instructions);
  }

  /** 分层压缩执行体：裁剪 → 摘要替换；失败置位 compactDisabled 防反复失败 */
  private async doCompact(instructions?: string): Promise<boolean> {
    // ① 历史裁剪：最便宜，先释放旧工具输出；裁剪后仍超限再走摘要
    const pruned = pruneToolResults(this.messages, this.compactConfig!.keepRecentToolResults);
    if (pruned !== this.messages) {
      this.messages = pruned;
      this.historyRewritten = true; // 已落盘的旧工具输出被替换为裁剪标记
      if (!needsCompact(estimateTokens(this.messages), this.compactConfig!)) return true;
    }
    // ② 压缩：带指导走现场摘要（DESIGN 9.8）；无指导且有会话记忆时用记忆替代
    // 现场摘要（DESIGN 9.7，省压缩时模型调用）；否则增量合并（已有旧摘要）或全量总结
    try {
      const recovery = buildRecoveryText(extractRecoveryContext(this.messages));
      let summary: string;
      let inFlight: Message[] = [];
      if (instructions) {
        // 现场摘要：指导随 Additional Instructions 段生效
        summary = await generateSummary(
          this.modelClient,
          this.modelId,
          this.messages,
          instructions,
          this.interruptController.signal,
        );
      } else if (this.memoryEnabled && this.memory.trim().length > 0) {
        // 记忆替代现场摘要（DESIGN 9.7，省压缩时模型调用）；但记忆只覆盖到上次 Stop，
        // 其后的在途消息（本次输入与工具回合）保留原文，不能静默丢弃
        summary = this.memory;
        inFlight = this.messages.slice(this.memoryCovered);
      } else {
        // 增量合并（DESIGN 9.7）：已有旧摘要时只总结摘要后的增量（附旧摘要供合并），
        // 模型不必重读全量历史，省 token 且多次压缩信息不丢
        const summaryIndex = this.messages.findIndex(
          (m) =>
            m.role === "user" &&
            m.source === "system" &&
            typeof m.content === "string" &&
            m.content.startsWith(SUMMARY_MARKER),
        );
        if (summaryIndex >= 0) {
          const previous = this.messages[summaryIndex]!.content as string;
          // 跳过紧随摘要的恢复上下文（内容源自压缩前全量历史，已被旧摘要覆盖，不算增量）；
          // 其余 source:"system" 消息（如邮箱注入）是真实增量，保留
          let deltaStart = summaryIndex + 1;
          if (
            deltaStart < this.messages.length &&
            typeof this.messages[deltaStart]!.content === "string" &&
            (this.messages[deltaStart]!.content as string).startsWith(RECOVERY_MARKER)
          ) {
            deltaStart++;
          }
          const delta = this.messages.slice(deltaStart);
          summary = await generateSummary(
            this.modelClient,
            this.modelId,
            delta.length > 0 ? delta : this.messages,
            `已有会话摘要：\n${previous}\n请基于旧摘要增量更新：旧摘要中未变化的内容不要重复展开，只合并新增部分`,
            this.interruptController.signal,
          );
        } else {
          summary = await generateSummary(
            this.modelClient,
            this.modelId,
            this.messages,
            undefined,
            this.interruptController.signal,
          );
        }
      }
      if (summary.trim().length === 0) {
        this.compactDisabled = true;
        return false;
      }
      this.messages = replaceWithSummary(summary);
      this.messages.push(...inFlight); // 记忆分支：在途消息保留原文；其他分支为空
      if (recovery) {
        // 恢复上下文由系统注入而非用户输入，标记 source: "system"
        this.messages.push(userMessage(`${RECOVERY_MARKER}\n${recovery}`, "system"));
      }
      this.historyRewritten = true; // 已落盘历史被摘要替换
      return true;
    } catch {
      // 中断导致的取消失效不算压缩失败——不在取消后误禁压缩（下次正常轮仍可撞线压缩）
      if (this.interruptController.signal.aborted) return false;
      this.compactDisabled = true;
      return false;
    }
  }

  /**
   * 读取并复位「历史被改写」标记（DESIGN 14 落盘一致性）：压缩/裁剪/超窗剥组
   * 改写过已落盘的历史，宿主在轮末据此重写整份持久化（agent 内存为真相）。
   * @returns 本回合是否改写过历史
   */
  consumeHistoryRewritten(): boolean {
    const was = this.historyRewritten;
    this.historyRewritten = false;
    return was;
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

  /** 发 Hook 事件但 handler 抛错不影响业务（CONTRACTS §3：事件处理出错不影响业务） */
  private async safeEmit(event: HookEvent): Promise<void> {
    if (!this.hooks) return;
    try {
      await this.hooks.emit(event);
    } catch {
      // hook 处理器异常被吞，最多漏该条观测，不中断回合
    }
  }

  /**
   * 执行单个工具调用；工具不存在或执行抛错时，以错误消息回灌。
   * 前置（hook 裁决 / 权限审批 / 参数校验）异常由外层兜底转失败结果，不抛断回合。
   * 返回工具结果消息与执行产出的上下文修改（供批末统一应用）。
   * @param call 工具调用（含工具名、调用 id 与参数）
   * @returns 工具结果消息与上下文修改
   */
  private async executeTool(call: ToolCall): Promise<ExecuteOutcome & { message: ToolResultMessage }> {
    try {
      return await this.executeToolInner(call);
    } catch (err) {
      // 前置阶段 hook 裁决 / 权限审批 / 参数校验的任何异常都转失败结果反馈模型，
      // 不让整个回合中断（保持观测闭合：调用开始后必有成功/失败事件）
      const error = err instanceof Error ? err.message : String(err);
      await this.safeEmit({
        type: "PostToolUseFailure",
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
        error: `工具调用过程出错：${error}`,
        agentPath: this.agentPath?.toString() ?? "/root",
      });
      return { message: toolResultMessage(call.id, call.name, `工具调用过程出错：${error}`, true) };
    }
  }

  /** executeTool 主体：前置校验/审批 → 中断检查 → 执行 → 回灌（异常由外层 executeTool 兜底转失败结果） */
  private async executeToolInner(call: ToolCall): Promise<ExecuteOutcome & { message: ToolResultMessage }> {
    // PreToolUse 在每次工具调用前无条件触发（DESIGN 13.1）——未知工具/参数校验失败也先发，
    // 配对闭合（调用开始后必有成功/失败事件）；hook 裁决对任何工具名生效
    const request: PermissionRequest = {
      toolName: call.name,
      content: typeof call.input.command === "string" ? call.input.command : undefined,
      input: call.input,
    };
    const hookVerdict = await this.preToolUseVerdict(call.id, request);
    const agentPath = this.agentPath?.toString() ?? "/root";
    // 无管线时 hook 裁决直接生效（deny 拒绝；ask 无审批者，fail 保守拒绝）——
    // 对未知工具同样生效（hook 拒绝优先于「未知工具」反馈）
    const hookRejects = hookVerdict === "deny" || hookVerdict === "ask";

    const tool = this.registry.get(call.name);
    if (!tool) {
      const available = this.registry
        .list()
        .map((t) => t.name)
        .join("、");
      // 有权限管线：未知工具也先走权限裁决（规则 deny 优先、hook 裁决与审批对任何工具名生效），
      // 拒绝给权限错误；放行才反馈「未知工具」——与注释「hook 拒绝优先于未知工具反馈」一致
      if (this.permission) {
        const hook = hookVerdict !== undefined ? async (): Promise<PermissionBehavior | undefined> => hookVerdict : undefined;
        const result = await this.permission.check(request, hook);
        if (!result.allowed) {
          const reason = result.reason ?? "未授权";
          // 未知工具被拒时附带「工具不存在 + 可用列表」，让模型能改选真实工具而非反复重试同一幻觉名
          const unknownHint = available ? `（工具不存在，可用工具：${available}）` : "";
          await this.safeEmit({
            type: "PostToolUseFailure",
            toolCallId: call.id,
            toolName: call.name,
            input: call.input,
            error: `权限拒绝：${reason}${unknownHint}`,
            agentPath,
          });
          return { message: toolResultMessage(call.id, call.name, `权限拒绝：${reason}${unknownHint}`, true) };
        }
      } else if (hookRejects) {
        // 无管线时 hook 裁决直接生效（hook 拒绝优先于「未知工具」反馈）
        const reason = hookVerdict === "deny" ? "Hook 拒绝" : "需要审批但未配置审批处理";
        await this.safeEmit({
          type: "PostToolUseFailure",
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
          error: `权限拒绝：${reason}`,
          agentPath,
        });
        return {
          message: toolResultMessage(call.id, call.name, `权限拒绝：${reason}`, true),
        };
      }
      // 未知工具：发失败事件（观测闭合：调用开始后必有成功/失败结果，此前确认）
      const error = `未知工具：${call.name}${available ? `，可用工具：${available}` : ""}`;
      await this.safeEmit({
        type: "PostToolUseFailure",
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
        error,
        agentPath,
      });
      return { message: toolResultMessage(call.id, call.name, error, true) };
    }
    // 前置参数校验：非法参数格式化为可读错误反馈模型，让其调整后重新调用
    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      const error = formatInputError(call.name, parsed.error);
      if (!this.permission && hookRejects) {
        const reason = hookVerdict === "deny" ? "Hook 拒绝" : "需要审批但未配置审批处理";
        await this.safeEmit({
          type: "PostToolUseFailure",
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
          error: `权限拒绝：${reason}`,
          agentPath,
        });
        return {
          message: toolResultMessage(call.id, call.name, `权限拒绝：${reason}`, true),
        };
      }
      await this.safeEmit({
        type: "PostToolUseFailure",
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
        error,
        agentPath,
      });
      return { message: toolResultMessage(call.id, call.name, error, true) };
    }
    // 权限审批：被拒则回灌错误消息、不执行工具，模型据此调整方案
    // 有权限管线时裁决并入 ask 决策链（规则层 deny 优先，Hook 只在 ask 时介入）；
    // 无权限管线时 hookVerdict 直接生效（上面工具逻辑已按 hookRejects 处理未知工具/参数失败，
    // 这里只处理工具存在且参数合法的场景）
    if (this.permission) {
      // 免审批工具（skipsPermission，如 agent 消息投递）走轻量检查：
      // 跳过规则/缓存/用户审批，保留 plan 只读约束与 PreToolUse hook 拦截（DESIGN 7.1）
      const hook = hookVerdict !== undefined ? async (): Promise<PermissionBehavior | undefined> => hookVerdict : undefined;
      const result = tool.skipsPermission
        ? await this.permission.checkSkipsPermission(request, hook)
        : await this.permission.check(request, hook);
      if (!result.allowed) {
        const reason = result.reason ?? "未授权";
        // 权限拒绝：发失败事件（观测闭合，此前确认）
        await this.safeEmit({
          type: "PostToolUseFailure",
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
          error: `权限拒绝：${reason}`,
          agentPath,
        });
        return {
          message: toolResultMessage(call.id, call.name, `权限拒绝：${reason}`, true),
        };
      }
    } else if (hookVerdict === "deny" || (hookVerdict === "ask" && !tool.skipsPermission)) {
      // 免审批工具（skipsPermission）的 ask 不升级用户审批、视为放行（与管线 checkSkipsPermission 一致）；
      // 普通工具无审批者时 fail 保守拒绝
      const reason = hookVerdict === "deny" ? "Hook 拒绝" : "需要审批但未配置审批处理";
      await this.safeEmit({
        type: "PostToolUseFailure",
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
        error: `权限拒绝：${reason}`,
        agentPath,
      });
      return {
        message: toolResultMessage(call.id, call.name, `权限拒绝：${reason}`, true),
      };
    }
    // 中断检查：许可已通过、准备真正启动调用前判定——若已被打断则不再启动，
    // 补失败结果保持观测闭合（PreToolUse 已发，后有 PostToolUseFailure）
    if (this.interruptController.signal.aborted) {
      const error = "执行中断：用户打断，工具未执行";
      await this.safeEmit({
        type: "PostToolUseFailure",
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
        error,
        agentPath,
      });
      return { message: toolResultMessage(call.id, call.name, error, true) };
    }
    try {
      // 工具中断看门狗：interrupt 后工具若不响应 signal（非 bash 类挂起）3s 强制转失败，
      // 与 withInterruptTimeout 配套保证打断后本轮必然收尾；
      // 只读快工具（glob/read/grep 等）另加正常执行超时：本应秒回却挂起不转圈（不依赖打断触发）
      const deadlines: Promise<never>[] = [interruptDeadline(this.interruptController.signal, TOOL_INTERRUPT_TIMEOUT_MS)];
      if (tool.isReadOnly) deadlines.push(executeDeadline(this.toolTimeoutMs));
      const result = await Promise.race([
        withCwd(this.cwd, () =>
          withFileState(
            this.fileState,
            () => tool.execute(call.input, { signal: this.interruptController.signal }),
          ),
        ),
        ...deadlines,
      ]);
      const { output, contextModifier, isError } =
        typeof result === "string"
          ? { output: result, contextModifier: undefined, isError: undefined }
          : result;
      const truncated = spillOutput(output, tool.maxResultSizeChars, this.outputDir);
      const finalOutput = truncated.content;
      // PostToolUse：工具执行完成（含标记失败的结果），供观测
      await this.safeEmit({
        type: "PostToolUse",
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
        output: finalOutput,
        isError: Boolean(isError),
        agentPath,
      });
      return {
        message: toolResultMessage(call.id, call.name, finalOutput, isError),
        contextModifier,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // PostToolUseFailure：工具执行抛错，供观测
      await this.safeEmit({
        type: "PostToolUseFailure",
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
        error,
        agentPath,
      });
      return {
        message: toolResultMessage(call.id, call.name, `工具 ${call.name} 执行失败：${error}`, true),
      };
    }
  }

  /**
   * PreToolUse Hook 裁决：触发事件总线（每次工具调用前，无条件），
   * 多个 hook 结果聚合为 deny 优先于 ask 优先于 allow（DESIGN 8.1 第一个反对即停）；
   * 无 hook 返回 undefined（有权限管线时继续走用户审批）。
   * @param request 权限请求（含工具名与完整参数）
   * @returns 裁决；无任何 hook 响应时返回 undefined
   */
  private async preToolUseVerdict(
    toolCallId: string,
    request: PermissionRequest,
  ): Promise<PermissionBehavior | undefined> {
    const event: HookEvent = {
      type: "PreToolUse",
      toolCallId,
      toolName: request.toolName,
      input: request.input ?? {},
      agentPath: this.agentPath?.toString() ?? "/root",
    };
    let results: (PermissionBehavior | void)[] | undefined;
    try {
      results = await this.hooks?.emit(event);
    } catch {
      // hook 处理器异常视为无裁决（事件处理出错不影响业务），走后续管线/无管线语义
    }
    if (results?.includes("deny")) return "deny";
    if (results?.includes("ask")) return "ask";
    if (results?.includes("allow")) return "allow";
    return undefined;
  }
}

/**
 * 修复末尾孤立的工具调用（DESIGN 14 checkpoint 崩溃恢复）：消息末尾是含工具调用的
 * assistant 时其 tool_result 必然未落盘（tool_result 紧跟调用，正常历史末尾不会是
 * 孤儿调用）。为其补「执行中断」失败结果保持配对完整（续跑不 400），
 * 模型看到「执行中断」自行决定重试或调整（比剥掉调用保留上下文）。
 * @param messages 加载的会话消息
 * @returns 修复后的消息数组
 */
function repairOrphanToolCalls(messages: Message[]): Message[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return messages;
  const calls = toolCallsOf(last);
  if (calls.length === 0) return messages;
  return [
    ...messages,
    ...calls.map((call) =>
      toolResultMessage(
        call.id,
        call.name,
        "工具执行中断：进程可能在执行中退出，结果未落盘，请重新确认状态后再执行",
        true,
      ),
    ),
  ];
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

/** 中断看门狗超时：signal 中止后流仍未结束的容忍窗口（ms） */
const INTERRUPT_STREAM_TIMEOUT_MS = 3_000;

/** 工具中断看门狗超时：signal 中止后工具仍未返回的容忍窗口（ms） */
const TOOL_INTERRUPT_TIMEOUT_MS = 3_000;

/** 只读快工具正常执行超时：glob/read/grep 等本应较快返回，超时兜底防挂起卡死回合（不依赖打断触发）；
 *  取 1min——大仓库下递归扫描（如巨型 monorepo 的 grep/glob）合法耗时可能不短，太紧会误杀正常完成 */
const TOOL_READONLY_TIMEOUT_MS = 60_000;

/**
 * 中断截止信号：signal 中止后 timeoutMs 内未完成则 reject（AbortError），
 * 与 withInterruptTimeout 配套——interrupt 后工具若不响应 signal（非 bash 类挂起），
 * 强制转失败结果，宿主输入循环不被卡死。
 * @param signal 中断信号
 * @param timeoutMs 中止后的容忍窗口
 * @returns 永不 resolve 的 promise（中止超时后 reject）
 */
function interruptDeadline(signal: AbortSignal, timeoutMs: number): Promise<never> {
  const promise = new Promise<never>((_resolve, reject) => {
    const rejectNow = (): void => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) rejectNow();
    else signal.addEventListener("abort", () => setTimeout(rejectNow, timeoutMs), { once: true });
  });
  // 防 unhandled rejection：Promise.race 已 settle 后迟到触发的 reject 不再报未处理
  promise.catch(() => undefined);
  return promise;
}

/**
 * 正常执行超时截止：timeoutMs 内工具未返回则 reject（超时错误）——兜底只读快工具的挂起
 * （glob/read/grep 等异常卡死不转圈、不因不响应中断而无限等）。与中断看门狗独立：
 * 该超时在正常运行期也生效，不依赖打扰信号；打断场景仍由 interruptDeadline 收尾。
 * @param timeoutMs 工具执行超时窗口
 * @returns 永不 resolve 的 promise（超时后 reject）
 */
function executeDeadline(timeoutMs: number): Promise<never> {
  const promise = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`工具执行超时：${timeoutMs / 1000}s 未返回`)), timeoutMs);
  });
  // 防 unhandled rejection：Promise.race 已 settle 后迟到触发的 reject 不再报未处理
  promise.catch(() => undefined);
  return promise;
}

/**
 * 中断看门狗：signal 中止后，流若在 timeoutMs 内仍未产出/结束（SDK 或厂商不响应 abort），
 * 强制抛 AbortError 结束迭代——保证 interrupt 后本轮必然快速收尾，
 * 宿主输入循环不会被永不结束的流卡死（真机「打断后命令全部无响应」根因）。
 * @param source 原始流
 * @param signal 中断信号
 * @param timeoutMs 中止后的容忍窗口
 * @returns 包装后的流
 */
async function* withInterruptTimeout<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
  timeoutMs: number,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    while (true) {
      const next = iterator.next();
      // 防 unhandled rejection：打断后挂起的 next 可能 reject（本处不 await 它）；
      // race 里 next 先 reject 时仍照常抛出，catch 不吞错误
      next.catch(() => undefined);
      const deadline = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          timer = setTimeout(() => reject(new DOMException("Aborted", "AbortError")), timeoutMs);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      const result = await Promise.race([next, deadline]);
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
        onAbort = undefined;
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // 清理残留的定时器与监听：race 的 reject 路径（打断超时/底层错误）不经过上面的清理，
    // 在此兜底——否则每次打断残留一个 3s 定时器、每次错误残留一个 abort 监听
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    // 不等待 return：永挂流（await 永不 settle）的 return() 也永不完成，等待会把收尾卡死；
    // 触发清理但不等结果，底层流正常时自会释放
    iterator.return?.().catch(() => undefined);
  }
}
