import {
  assembleAssistantMessage,
  COMMAND_MARKER,
  createContext,
  type ThinkingLevel,
  toolCallsOf,
  toolResultMessage,
  userMessage,
  type AssistantMessage,
  type Context,
  type Message,
  type ModelUsage,
  type StreamEvent,
  type ToolCall,
  type ToolResultMessage,
} from "../core/index.js";
import {
  buildRecoveryText,
  environmentPrompt,
  estimateTextTokens,
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
import type { PermissionBehavior, PermissionPipeline, PermissionRequest, PermissionResult } from "../permission/index.js";
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

/** 超窗应急剥组的最大重试次数（剥组与重试有上限，超限报错） */
const MAX_CONTEXT_RETRY = 3;

/** 会话记忆文本上限（防无限膨胀，超出截断） */
const MAX_MEMORY_CHARS = 4000;
/** 单次记忆更新的批大小（条）：按未覆盖区取最旧一批，覆盖点精确推进 */
const MEMORY_UPDATE_BATCH = 16;

export interface AgentOptions {
  modelClient: ModelClient;
  modelId: string;
  systemPrompt: string;
  tools?: Tool[];
  /** 初始消息（会话续跑时传入历史），默认为空 */
  initialMessages?: Message[];
  /** 上下文压缩配置；不传则不做撞线压缩 */
  compactConfig?: CompactConfig;
  /** 撞线自动压缩开关（缺省开）：false 仅关掉撞线自动触发；压缩配置仍供
   *  /compact 手动路径使用（开关与配置有无解耦，手动压缩不受限） */
  autoCompact?: boolean;
  /** 权限管线；不传则工具执行前不做权限检查 */
  permission?: PermissionPipeline;
  /** Hook 事件总线；不传则不触发 Hook 事件 */
  hooks?: HookBus;
  /** 工具输出超限的落盘目录；缺省 `~/.minicode/outputs/`（测试可注入 tmp 目录） */
  outputDir?: string;
  /** 会话 id（超限工具输出落盘文件名编入，产出方可回溯；子 agent 随继承透传） */
  sessionId?: string;
  /** 思考等级活引用（/model 左右调整实时生效）：每轮组装 Context 时读一次，透传 reasoning_effort（仅支持的厂商） */
  thinkingLevelRef?: () => ThinkingLevel | undefined;
  /** 工具执行的工作目录（相对路径解析基准）；缺省进程 cwd */
  cwd?: string;
  /**
   * checkpoint 回调：每批工具执行前调用，传入当前全部消息——
   * 宿主在此把已产生的消息（用户输入 + 模型回复含工具调用）落盘，
   * 工具副作用不可逆，执行前崩溃时历史在盘上可恢复续跑
   */
  checkpoint?: (messages: Message[]) => Promise<void> | void;
  /** 启用会话记忆：每轮结束后模型增量维护记忆，压缩时用记忆替代现场摘要省模型调用 */
  memory?: boolean;
  /** 只读快工具正常执行超时（ms）：glob/read/grep 等本应秒回，异常挂起时兜底强制失败；默认 60s */
  toolTimeoutMs?: number;
  /** 归属的团队：传入即在多 agent 环境注册协作工具，普通单 agent 会话不展示 */
  team?: Team;
  /** 协作子 agent 的提示词附加段（项目指令段 + 可用技能段，宿主装配时传入）；
   *  派生时拼在协作提示之后、环境段之前，子 agent 与 root 同守项目约定、可取用技能 */
  subagentPromptSections?: string[];
}

/** Agent 主循环：显式步骤序列，驱动模型对话与工具执行 */
export class Agent {
  private readonly modelClient: ModelClient;
  private readonly modelId: string;
  private readonly systemPrompt: string;
  /** 只读快工具正常执行超时（ms） */
  private readonly toolTimeoutMs: number;
  /** 协作子 agent 的提示词附加段：派生时拼进子 agent 系统提示词 */
  private readonly subagentPromptSections: string[];
  private readonly registry: ToolRegistry;
  private readonly compactConfig?: CompactConfig;
  /** 撞线自动压缩开关：false 时 maybeCompact 不触发，手动 compactNow 不受影响 */
  private readonly autoCompact: boolean;
  private readonly permission?: PermissionPipeline;
  private readonly hooks?: HookBus;
  /** 本 agent 的文件状态快照：read 记录版本、write/edit 校验，多 agent 并行写冲突由它兜底 */
  private readonly fileState = new FileState();
  /** 归属的团队（多 Agent 协作）；不传则本 agent 独立运行、不展示协作工具 */
  private readonly team?: Team;
  /** 本 agent 在团队中的层级路径；注册进团队时由 Team 设置 */
  agentPath?: AgentPath;
  /** 工具输出超限的落盘目录 */
  private readonly outputDir: string;
  private readonly sessionId: string | undefined;
  /** 工具执行的工作目录（相对路径解析基准） */
  private readonly cwd: string;
  /** checkpoint 回调：工具执行前宿主落盘用 */
  private readonly checkpoint?: (messages: Message[]) => Promise<void> | void;
  /** 会话记忆是否启用 */
  private readonly memoryEnabled: boolean;
  /** 会话记忆文本（模型持续维护的关键信息，压缩时替代现场摘要） */
  private memory = "";
  /** 记忆已覆盖的消息数（上次记忆更新时）：压缩时其后的消息为「在途」，保留原文不丢 */
  private memoryCovered = 0;
  /** 后台记忆更新串行链（fire-and-forget 的排队与收尾观察都挂在这条链上） */
  private memoryChain: Promise<void> = Promise.resolve();
  /** 更新跑动中又收到收尾触发的尾随标记：更新完成后按最新消息补跑一次 */
  private memoryQueued = false;
  /** agent 邮箱：其他 agent 投递的消息队列，注入上下文供模型读取 */
  private readonly mailbox = new Mailbox();
  private messages: Message[] = [];
  /** 摘要压缩失败后置位，停止后续压缩尝试（失败保护） */
  private compactDisabled = false;
  /** 历史被改写标记（压缩/裁剪/超窗剥组改过已落盘消息）：宿主据此重写持久化，防落盘与内存错位 */
  private historyRewritten = false;
  /** Stop 已触发：run 结束；多 Agent 场景下收件箱来消息可唤醒续跑 */
  private stopped = false;
  /** 是否有活跃的续跑循环（防重复驱动：忙时投递只入队，活跃循环自行消费） */
  private active = false;
  /** 是否被中断（interrupt 请求过：停止当前任务，未产出结论） */
  private interrupted = false;
  /** 当前轮的中断信号（turn 内真打断）：interrupt 中止进行中的模型流/工具执行；start 新建复位 */
  private interruptController = new AbortController();
  /** 思考等级活引用（每轮组装 Context 时读一次；undefined=用厂商默认） */
  private readonly thinkingLevelRef?: () => ThinkingLevel | undefined;
  /** LlmCallEnd 已附过全文的系统提示词版本：hash 每次必带，
   *  全文仅首次出现或变更时附带，轨迹据此含提示词各版本全文而不逐条重复 */
  private emittedSystemPrompt: string | null = null;
  /** 崩溃恢复补孤儿的合成消息（待发射）：构造同步无法发射事件，待首次驱动时补发
   *  MessageAppended 补齐轨迹——否则压缩重写落盘后这些消息在任何记录里都无迹可查 */
  private pendingRepairMirrors: Message[] = [];

  constructor(options: AgentOptions) {
    this.modelClient = options.modelClient;
    this.modelId = options.modelId;
    this.systemPrompt = options.systemPrompt;
    this.thinkingLevelRef = options.thinkingLevelRef;
    this.toolTimeoutMs = options.toolTimeoutMs ?? TOOL_READONLY_TIMEOUT_MS;
    this.subagentPromptSections = options.subagentPromptSections ?? [];
    this.compactConfig = options.compactConfig;
    this.autoCompact = options.autoCompact ?? true;
    this.permission = options.permission;
    this.hooks = options.hooks;
    this.outputDir = options.outputDir ?? resolveOutputsDir();
    this.sessionId = options.sessionId;
    this.cwd = options.cwd ?? process.cwd();
    this.team = options.team;
    this.checkpoint = options.checkpoint;
    this.memoryEnabled = options.memory ?? false;
    this.registry = new ToolRegistry();
    for (const tool of options.tools ?? []) {
      this.registry.register(tool);
    }
    // 多 agent 环境：注册协作工具（仅团队内可见）
    if (this.team) {
      for (const tool of createCollaborationTools({
        team: this.team,
        getAgentPath: () => this.agentPath,
        createChildAgent: (agentName, path, worktree) => this.createChildAgent(agentName, path, worktree),
        sendMessage: (target, mail) => this.team!.sendMessage(target, mail),
        worktreeDefault: () => this.team!.worktreeDefault,
      })) {
        this.registry.register(tool);
      }
    }
    if (options.initialMessages) {
      // checkpoint 崩溃恢复：末尾可能残留「工具调用无结果」的孤儿状态——
      // 工具执行前已落盘但结果未及写盘。补失败结果保持配对完整（续跑不 400），
      // 模型看到「执行中断」自行决定重试或调整（比剥掉调用保留上下文）
      const repaired = repairOrphanToolCalls(options.initialMessages);
      // 合成的失败结果记入待发射清单：构造函数不能发射事件（宿主可能尚未完成装配），
      // 首次驱动时补发 MessageAppended，轨迹与落盘才含这些真实进入上下文的消息
      this.pendingRepairMirrors = repaired.slice(options.initialMessages.length);
      this.messages.push(...repaired);
    }
  }

  /**
   * 创建协作子 agent：全新上下文 + 运行时继承
   * （模型 / 权限 / Hook / 团队 / 落盘目录），工具 = 父工具集过滤协作工具 + 协作工具。
   * @param agentName 子 agent 名（路径末段，已由 reserveSpawn 校验）
   * @param path 子 agent 在团队中的路径
   * @param worktree 是否给子 agent 独立 git worktree 工作区（spawn 派生时的逐次选择，
   *  缺省随 Team 全局缺省）；不可用（非 git 仓库/创建失败）时自动继承父 cwd
   * @returns 子 agent 实例（路径已设置，待 commitSpawn 登记）
   */
  private createChildAgent(agentName: string, path: AgentPath, worktree?: boolean): Agent {
    // Git Worktree 隔离：开启且父在 git 仓库内时，子 agent 绑定独立工作区（cwd），
    // 文件写与父物理隔离；不可用时继承父 cwd
    const worktreeInfo = this.team?.createChildWorktree(path, worktree);
    const childCwd = worktreeInfo?.dir ?? this.cwd;
    // 子 agent 提示词：固定协作提示 + 装配段（项目指令/可用技能，
    // 宿主传入）+ 环境段（按子 agent 实际 cwd 生成，worktree 隔离时是子工作区路径）
    const childPrompt = [
      COLLAB_SUBAGENT_PROMPT,
      ...this.subagentPromptSections.filter((section) => section.length > 0),
      environmentPrompt(childCwd),
    ].join("\n");
    const child = new Agent({
      modelClient: this.modelClient,
      modelId: this.modelId,
      systemPrompt: childPrompt,
      tools: this.registry.list().filter((tool) => !COLLAB_TOOL_NAMES.has(tool.name)),
      permission: this.permission,
      hooks: this.hooks,
      team: this.team,
      outputDir: this.outputDir,
      sessionId: this.sessionId,
      cwd: childCwd,
      // 思考等级随父继承（会话级偏好，子 agent 与 root 一致）
      thinkingLevelRef: this.thinkingLevelRef,
      // 装配段随链传递：孙 agent 派生时同样注入
      subagentPromptSections: this.subagentPromptSections,
    });
    child.agentPath = path;
    return child;
  }

  /**
   * 追加用户输入，开始新一轮对话。
   * @param input 用户输入内容
   */
  start(input: string): void {
    // 新一轮用户输入到来：重置 Stop，允许再次跑 turn；
    // 同步复位中断状态（新对话 = 新的生命周期，上一轮中断作废，结论可正常回灌），
    // 并新建中断信号（上一轮的 abort 不作用于新对话）
    this.stopped = false;
    this.interrupted = false;
    this.interruptController = new AbortController();
    const message = userMessage(input);
    // 用户消息入上下文前先补发待镜像消息：合成的恢复消息在历史末尾、本轮输入之前，
    // 先发它们轨迹的消息顺序才与上下文一致
    this.flushPendingRepairMirrors();
    this.messages.push(message);
    // 同步方法内发射不等待：HookBus.emit 调用即同步到达首个 handler，订阅方同步记账则到达序=发生序
    void this.emitMessageAppended(message);
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
    // 清盘即丢弃未发射的待镜像消息：消息已不在上下文，补发只会让轨迹多出不存在的消息
    this.pendingRepairMirrors = [];
    // 记忆一并清空（/clear 语义是回会话新建态）：旧会话的记忆文本不跨会话残留，
    // 覆盖点也归零——它指旧会话下标会让新会话的消息永远进不了记忆、压缩时被当已覆盖替换
    this.memory = "";
    this.memoryCovered = 0;
  }

  /**
   * 追加一条命令消息（命令痕迹）：/init /compact 等命令的持久化记录，退出/切换
   * 会话再回来时据此重演「命令 + 其后对话」。消息带 source: "command"，只落持久化
   * 供界面重演，不回灌模型（requestMessages 会剥掉；发给模型会被当成新的用户请求）。
   * @param text 命令原文（如 "/compact 侧重保留命令输出"）
   */
  appendCommand(text: string): void {
    const message = userMessage(`${COMMAND_MARKER}${text}`, "command");
    // 命令消息入上下文前先补发待镜像消息：恢复会话的首动作可以是 /init /compact（宿主
    // 先 appendCommand 再 start），先发它们轨迹的消息顺序才与上下文一致
    this.flushPendingRepairMirrors();
    this.messages.push(message);
    // 同步方法内发射不等待（同 start 的保序说明）
    void this.emitMessageAppended(message);
  }

  /** 工具执行的工作目录（相对路径解析基准；Team 创建 worktree 时读取） */
  getCwd(): string {
    return this.cwd;
  }

  /**
   * 投递消息到本 agent 邮箱（供 Team 调度投递）。
   * @param mail 消息（类型、发送方、内容、是否唤醒）
   */
  deliver(mail: MailMessage): void {
    this.mailbox.enqueue(mail);
  }

  /** 收件箱是否有未消费消息（调度器 runnable 判定） */
  hasPendingMail(): boolean {
    return this.mailbox.hasPending();
  }

  /** 清空收件箱（Team 会话收尾调用）：排队消息会让中断的 agent 在 resume 里复活续跑——
   *  重新拉起模型流吊住进程 */
  clearMailbox(): void {
    this.mailbox.drain();
  }

/**
   * 会话驱动入口（宿主调用）：推进 turn 直到会话结束。
   * 会话级 Hook（SessionStart / UserPromptSubmit）由宿主触发——
   * SessionStart 在会话开始（创建后首次驱动前）一次，UserPromptSubmit 在每次用户输入后一次。
   */
  async *run(): AsyncGenerator<StreamEvent> {
    yield* this.resume();
  }

  /**
   * 续跑循环（供调度器唤醒驱动）：与 run 相同的 turn 推进，但不触发
   * 会话级 Hook（SessionStart / UserPromptSubmit 只属于用户驱动）。
   * 每轮跑完后：收件箱有续跑型消息（消息/任务/结论）→ 复位继续，下一轮 runTurn 消费注入；
   * 只有中断标记 → 被打断时保持终态退出（标记留给下次输入消费，不顶着打断意图
   * 重启），未被打断时继续下一轮消费；收件箱空且终态（模型已回复无工具调用）→ 结束；
   * 工具循环续轮（模型仍在调工具）→ 继续。
   * 循环无轮次上限：自然边界是撞线压缩（水位）与用户中断（Esc）。
   * 空闲（loop 结束）后的唤醒只由 triggerTurn 消息经 Team 驱动发起。
   * 防重入：已有活跃续跑循环时直接返回（忙时投递只入队，活跃循环在每轮结束自行消费）。
   */
  async *resume(): AsyncGenerator<StreamEvent> {
    if (this.active) return;
    this.active = true;
    // 复活（新一轮驱动，中断后可复活）：复位中断状态——
    // 上一轮 interrupt 置位只影响当时的 notifyCompletion 判定，新一轮结论应正常回灌父；
    // 同步新建中断信号，上一轮的 abort 不作用于新一轮
    this.interrupted = false;
    this.interruptController = new AbortController();
    try {
      while (true) {
        for await (const event of this.runTurn()) {
          yield event;
        }
        // 收件箱有续跑型消息 → 继续 loop：轮间继续 = 新任务，中断状态一并复位
        // （原实现只入口复位，interrupt 落活跃循环中途 + 排队消息继续时，
        // 新任务结论仍被 notifyCompletion 吞掉）
        if (this.mailbox.hasReviving()) {
          this.stopped = false;
          this.interrupted = false;
          this.interruptController = new AbortController();
          continue;
        }
        // 收件箱只剩中断标记：被中断则保持终态退出（Esc 级联下父与子同时被打断，
        // 标记是排队的状态通知不是新任务）；未被中断（如父主动 interrupt_agent 后
        // 继续跑）则继续下一轮消费标记
        if (this.mailbox.hasPending()) {
          if (this.stopped) return;
          continue;
        }
        // 收件箱空且终态（本轮模型回复无工具调用）→ 会话结束；
        // 否则继续下一轮（工具循环续轮，直到模型收尾或用户中断）
        if (this.stopped) return;
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

  /** 最后一条 assistant 结论文本（completion watcher 回灌父 agent 用） */
  conclusionText(): string {
    return lastAssistantText(this.messages);
  }

  /**
   * 执行单个 turn（多 Agent 协作的 turn 级调度单元）。
   * 每 turn：撞线压缩 → 组装上下文 → 流式调用模型 → 回灌回复 →
   * 无工具调用则置 Stop 结束，否则执行工具调用并回灌结果。
   * 结束（Stop）后不再产生事件；收件箱消息可在后续注入唤醒续跑。
   * 会话级 Hook（SessionStart / UserPromptSubmit）由宿主触发，本方法保持纯粹。
   */
  async *runTurn(): AsyncGenerator<StreamEvent> {
    // 首次驱动先补发待镜像消息（不经 start 的驱动路径：收件箱唤醒续跑、直调 runTurn），
    // 置于守卫之前——消息真实在上下文中，与本轮是否跑起来无关
    this.flushPendingRepairMirrors();
    if (this.stopped) return;

    await this.maybeCompact();
    // 消费收件箱消息：注入 source:"system"（消息即上下文，模型直接读文本）
    if (this.mailbox.hasPending()) {
      for (const mail of this.mailbox.drain()) {
        await this.appendMessage(userMessage(formatMailMessage(mail), "system"));
      }
    }
    let context = createContext(this.systemPrompt, this.requestMessages(), this.registry.definitions(), this.contextThinkingLevel());
    const collected: StreamEvent[] = [];
    const agentPath = this.agentPath?.toString() ?? "/root";
    // 本轮实际产出模型：路由切到备选时更新，组装后写入消息 meta 供署名/重演一致展示
    let effectiveModel = this.modelId;
    // 超窗应急剥组重发：API 返回超窗错误时剥掉最近几组工具回合后重发当前轮，
    // 不做摘要；剥组与重试有上限，超限直接报错并恢复剥前消息（剥组是重试手段，失败不留副作用）
    const messagesBeforeRetry = this.messages;
    let retryAttempts = 0;
    for (;;) {
      // 一次 API 尝试的测量窗口（LlmCallEnd）：超窗剥组重试与模型链切换
      // 产生多次尝试，各自独立收口一条调用事件（每次都是独立的耗时与用量）
      let attemptStart = Date.now();
      let attemptFirstEventMs: number | undefined;
      let attemptUsage: ModelUsage | undefined;
      let attemptStopReason: string | undefined;
      let attemptError: string | undefined;
      try {
        for await (const event of withInterruptTimeout(
          this.modelClient.stream(this.modelId, context, { signal: this.interruptController.signal }),
          this.interruptController.signal,
          INTERRUPT_STREAM_TIMEOUT_MS,
        )) {
          // 中断引发的流错误统一到 error 事件，不向宿主转发（interrupt 语义已覆盖，宿主不见「中断=错误」）
          if (this.interruptController.signal.aborted && event.type === "error") continue;
          attemptFirstEventMs ??= Date.now() - attemptStart;
          if (event.type === "model_fallback") {
            // 轨迹镜像 ModelFallback（切换原因随事件转发），并收口被
            // 切换掉的尝试：reason=error 说明该模型真实尝试过且失败（error 事件文本优先）；
            // cooldown/unresolved 是条目被跳过、未发起调用，无调用事件可记
            await this.safeEmit({ type: "ModelFallback", agentPath, from: event.from, to: event.to, reason: event.reason });
            if (event.reason === "error") {
              await this.emitLlmCallEnd({
                model: event.from,
                durationMs: Date.now() - attemptStart,
                firstEventMs: attemptFirstEventMs,
                error: attemptError ?? "模型调用失败，已切换备选",
              });
            }
            effectiveModel = event.to;
            attemptStart = Date.now();
            attemptFirstEventMs = undefined;
            attemptUsage = undefined;
            attemptStopReason = undefined;
            attemptError = undefined;
          }
          // 观察事件（模型路由切换提示）只透传宿主观测，不进 collected——否则 assemble 会把
          // 它的长度误算为「已产出」（中断收尾以 collected.length 判断要不要落半截回复）
          if (event.type !== "model_fallback") collected.push(event);
          if (event.type === "done") {
            attemptStopReason = event.stopReason;
            attemptUsage = event.usage;
          } else if (event.type === "error") {
            attemptError = event.message;
          }
          yield event;
        }
        // 流正常结束：收口本次尝试。中断收尾按失败记（停因/用量缺失属被中断的预期状态）
        if (this.interruptController.signal.aborted) {
          await this.emitLlmCallEnd({
            model: effectiveModel,
            durationMs: Date.now() - attemptStart,
            firstEventMs: attemptFirstEventMs,
            error: "用户中断",
          });
        } else {
          await this.emitLlmCallEnd({
            model: effectiveModel,
            durationMs: Date.now() - attemptStart,
            firstEventMs: attemptFirstEventMs,
            usage: attemptUsage,
            stopReason: attemptStopReason,
            error: attemptError,
          });
        }
        break;
      } catch (err) {
        // 中断：跳出重试循环，走已产出保留收尾（不由超窗剥组重发）
        if (this.interruptController.signal.aborted) {
          await this.emitLlmCallEnd({
            model: effectiveModel,
            durationMs: Date.now() - attemptStart,
            firstEventMs: attemptFirstEventMs,
            error: "用户中断",
          });
          break;
        }
        if (!isContextTooLongError(err) || retryAttempts >= MAX_CONTEXT_RETRY) {
          this.messages = messagesBeforeRetry;
          await this.emitLlmCallEnd({
            model: effectiveModel,
            durationMs: Date.now() - attemptStart,
            firstEventMs: attemptFirstEventMs,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
        const peeled = peelToolGroups(this.messages, parseContextTooLongGap(err));
        if (!peeled) {
          this.messages = messagesBeforeRetry;
          await this.emitLlmCallEnd({
            model: effectiveModel,
            durationMs: Date.now() - attemptStart,
            firstEventMs: attemptFirstEventMs,
            error: "上下文超限且无工具回合可剥，无法重试",
          });
          throw err;
        }
        await this.emitLlmCallEnd({
          model: effectiveModel,
          durationMs: Date.now() - attemptStart,
          firstEventMs: attemptFirstEventMs,
          error: "上下文超限，剥组重试",
        });
        this.messages = peeled;
        this.historyRewritten = true; // 已落盘的工具回合被剥除
        // 覆盖点钳制：剥组保留组间游离消息、旧消息下标会前移，极端情况下剩余长度
        // 小于覆盖点即越界——收回到新数组长度内兜底；剩余长度仍覆盖点的场景下
        // 前移导致的「未覆盖消息被当已覆盖」按剥组应急丢弃语义接受（被剥消息本就丢弃）
        this.memoryCovered = Math.min(this.memoryCovered, this.messages.length);
        context = createContext(this.systemPrompt, this.requestMessages(), this.registry.definitions(), this.contextThinkingLevel());
        collected.length = 0;
        retryAttempts++;
      }
    }
    const assistant: AssistantMessage = await assembleAssistantMessage(toAsyncIterable(collected));
    // 消息归属：记录实际产出模型（含路由切到备选），重演/署名与底栏、会话列表一致
    assistant.meta = { ...assistant.meta, model: effectiveModel };
    // 中断收尾（turn 内真打断）：已产出的文本/思考保留为 assistant；含但未执行的工具调用
    // 补失败结果保持配对闭合（续跑不 400，模型看到「执行中断」自行决定重试或调整）；
    // 完全没收到内容则连空消息也不落。中断后本轮结束，已产出留在历史、可正常续跑。
    if (this.interruptController.signal.aborted) {
      if (collected.length > 0) {
        await this.appendMessage(assistant);
        for (const call of toolCallsOf(assistant)) {
          await this.appendMessage(
            toolResultMessage(call.id, call.name, "执行中断：用户打断，工具未执行", true),
          );
        }
      }
      this.stopped = true;
      return;
    }
    await this.appendMessage(assistant);

    const calls = toolCallsOf(assistant);
    if (calls.length === 0) {
      // Stop：模型回复无工具调用，本轮对话准备结束。
      // 带 agentPath（多 agent 下区分「谁」空闲）：TUI 据此只把主 agent 的 Stop 视为回合空闲
      //（子 agent 轮次结束不应把主界面打成空闲）
      this.stopped = true;
      await this.safeEmit({ type: "Stop", agentPath: this.agentPath?.toString() ?? "/root" });
      // 会话记忆：回合收尾后台增量维护记忆——回合完整收尾后触发，
      // 更新 fire-and-forget 不阻塞回合结束，更新跑动中再触发合并为尾随一次
      if (this.memoryEnabled) {
        this.scheduleMemoryUpdate();
      }
      return;
    }

    // checkpoint：工具副作用不可逆，执行前让宿主把本轮已产生的
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
      await this.appendMessage(message);
    }
  }

  /**
   * 调度后台记忆更新：更新串行挂在 memoryChain 上，跑动中再触发只合并为一次尾随
   * 更新（更新完成时按最新消息补跑，不叠加排队调用）。
   */
  private scheduleMemoryUpdate(): void {
    if (this.memoryQueued) return;
    this.memoryQueued = true;
    this.memoryChain = this.memoryChain.then(async () => {
      this.memoryQueued = false;
      await this.updateMemoryOnce();
    });
  }

  /** 等待后台记忆更新全部收尾（测试与宿主退出排空用；无挂起更新时立即返回） */
  whenMemorySettled(): Promise<void> {
    return this.memoryChain;
  }

  /**
   * 单次记忆更新：只喂上次覆盖点之后的未覆盖消息（按批取最旧一批，覆盖点精确推进），
   * 杜绝「最近 8 条」窗口在覆盖点之间留下永远进不了记忆的空洞——空洞段会在记忆替代
   * 压缩时被静默丢弃。覆盖点记调用时刻的实际覆盖位置（快照），
   * 更新期间新到消息留给下次更新，不误标已覆盖。
   */
  private async updateMemoryOnce(): Promise<void> {
    // 未覆盖区取最旧一批（时间序）：覆盖点按实际发送范围推进，多轮后台更新逐步消化积压
    const uncovered = this.messages.slice(this.memoryCovered);
    // 无未覆盖消息即短路：覆盖点错位时空批次也会白发一次模型调用（修复前的错位源已堵，
    // 这里兜住其余路径，保证任何情况下不给记忆更新发空请求）
    if (uncovered.length === 0) return;
    const recent = uncovered.slice(0, MEMORY_UPDATE_BATCH);
    const coveredAt = this.memoryCovered + recent.length;
    try {
      const updated = await updateMemory(
        this.modelClient,
        this.modelId,
        {
          currentMemory: this.memory,
          recentMessages: recent,
          maxRecentMessages: recent.length, // 批内不再二次截断：覆盖点与实际发送范围严格一致
        },
        this.interruptController.signal,
      );
      if (updated.trim().length > 0) {
        this.memory = updated.trim().slice(0, MAX_MEMORY_CHARS);
        this.memoryCovered = Math.max(this.memoryCovered, coveredAt);
      }
    } catch {
      // 记忆更新失败不影响对话主流程（含用户打断中止）；覆盖点不前进，下次更新重试同一区间
    }
  }

  /**
   * 撞线压缩检查（分层）：先历史裁剪（最便宜），仍超限再 LLM 摘要。
   * 摘要压缩失败后置位停止后续尝试（失败保护）。
   */
  private async maybeCompact(): Promise<void> {
    if (!this.compactConfig || !this.autoCompact || this.compactDisabled) return;
    if (!needsCompact(this.estimateContextTokens(), this.compactConfig)) return;
    await this.doCompact("auto");
  }

  /**
   * 当前上下文的估算 token：消息 + 系统提示词。每次请求全量携带 systemPrompt，
   * 只按消息估算会系统性低估体积，长提示词会话（指令文件 + 技能清单）的压缩触发点明显滞后。
   * 公开给宿主：TUI 状态行的上下文水位与压缩触发共用同一估算——用户看到的水位就是压缩判断用的水位。
   */
  estimateContextTokens(): number {
    return estimateTokens(this.messages) + estimateTextTokens(this.systemPrompt);
  }

  /**
   * 用户主动压缩（/compact）：无视撞线判断强制走分层压缩
   * （裁剪旧工具输出 → 摘要替换），返回是否发生压缩（供宿主反馈）。
   * 带压缩指导时跳过会话记忆替代路径、改走现场摘要——记忆是现成
   * 文本，指导无从生效；无指导保留记忆替代省调用路径。
   * 显式请求可绕过 compactDisabled 失败保护重试（撞线自动压缩仍受保护）。
   * 压缩替换消息后，宿主需把新消息落盘并与持久化游标联动。
   * @param instructions 压缩指导（可省略）：以 Additional Instructions 段追加摘要提示词末尾
   * @returns 是否成功压缩（未配置压缩或摘要失败时 false）
   */
  async compactNow(instructions?: string): Promise<boolean> {
    if (!this.compactConfig) return false;
    return this.doCompact("manual", instructions);
  }

  /** 分层压缩执行体：裁剪 → 摘要替换；失败置位 compactDisabled 防反复失败。
   *  进入本方法即视为一次压缩动作，收口时发一条 Compact 事件（成功失败都发） */
  private async doCompact(trigger: "auto" | "manual", instructions?: string): Promise<boolean> {
    // 先排空在途记忆更新：更新按旧数组推进覆盖点，压缩等它收尾后切片，
    // 否则压缩重排与更新的 stale 覆盖点回写交错，重排被 Math.max 回写抵消
    await this.whenMemorySettled();
    // 压缩前补发待镜像消息：维持「在途消息压缩前已发过 MessageAppended」的时序约定，
    // 恢复会话未经回合直接 /compact 时合成消息才不随摘要替换静默消失
    this.flushPendingRepairMirrors();
    const startedAt = Date.now();
    const agentPath = this.agentPath?.toString() ?? "/root";
    const tokensBefore = this.estimateContextTokens();
    const messagesBefore = this.messages.length;
    // 收口 Compact 事件：tokensAfter/messagesAfter 按收口时刻的上下文实测
    const emitCompact = async (ok: boolean, error?: string): Promise<void> => {
      await this.safeEmit({
        type: "Compact",
        agentPath,
        trigger,
        tokensBefore,
        tokensAfter: this.estimateContextTokens(),
        messagesBefore,
        messagesAfter: this.messages.length,
        durationMs: Date.now() - startedAt,
        ok,
        ...(error ? { error } : {}),
      });
    };
    // ① 历史裁剪：最便宜，先释放旧工具输出；裁剪后仍超限再走摘要。
    // 带压缩指导时不短路：指导必须经现场摘要生效，裁剪达标也继续摘要
    const pruned = pruneToolResults(this.messages, this.compactConfig!.keepRecentToolResults);
    if (pruned !== this.messages) {
      this.messages = pruned;
      this.historyRewritten = true; // 已落盘的旧工具输出被替换为裁剪标记
      if (!instructions && !needsCompact(this.estimateContextTokens(), this.compactConfig!)) {
        await emitCompact(true);
        return true;
      }
    }
    // ② 压缩：带指导走现场摘要；无指导且有会话记忆时用记忆替代
    // 现场摘要（省压缩时模型调用）；否则增量合并（已有旧摘要）或全量总结
    try {
      const recovery = buildRecoveryText(extractRecoveryContext(this.messages));
      let summary: string;
      let inFlight: Message[] = [];
      let usedMemory = false;
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
        // 记忆替代现场摘要（省压缩时模型调用）；但记忆只覆盖到上次 Stop，
        // 其后的在途消息（本次输入与工具回合）保留原文，不能静默丢弃
        usedMemory = true;
        summary = this.memory;
        inFlight = this.messages.slice(this.memoryCovered);
      } else {
        // 增量合并：已有旧摘要时只总结摘要后的增量（附旧摘要供合并），
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
        await emitCompact(false, "摘要结果为空");
        return false;
      }
      const summaryMessages = replaceWithSummary(summary);
      this.messages = summaryMessages;
      // 非记忆分支的摘要同样捕获了全量历史：写入记忆，维持「已覆盖 ⇒ 已进记忆」——
      // 否则下次记忆分支压缩用旧记忆替换上下文，记忆没覆盖的段落被静默丢弃
      if (this.memoryEnabled && !usedMemory) {
        this.memory = summary.trim().slice(0, MAX_MEMORY_CHARS);
      }
      // 覆盖点重排：摘要消息本身视为已覆盖（记忆分支它就是记忆文本；其他分支摘要已
      // 写入记忆，同样成立），其后推入的在途与恢复消息全部回到未覆盖区正常消化。
      // 不重排的后果：旧覆盖点指向已不存在的下标，每轮记忆更新空批次白发模型调用、
      // 在途消息永远进不了记忆，下次压缩在途切片取空导致历史删除且记忆里也没有（静默丢数据）
      this.memoryCovered = 1;
      // 摘要消息是新进入上下文的消息，镜像进轨迹；在途消息压缩前已发过 MessageAppended，重灌不重发
      await this.emitMessageAppended(summaryMessages[0]!);
      this.messages.push(...inFlight); // 记忆分支：在途消息保留原文；其他分支为空
      if (recovery) {
        // 恢复上下文由系统注入而非用户输入，标记 source: "system"
        const recoveryMessage = userMessage(`${RECOVERY_MARKER}\n${recovery}`, "system");
        this.messages.push(recoveryMessage);
        await this.emitMessageAppended(recoveryMessage);
      }
      this.historyRewritten = true; // 已落盘历史被摘要替换
      await emitCompact(true);
      return true;
    } catch (err) {
      // 中断导致的取消失效不算压缩失败——不在取消后误禁压缩（下次正常轮仍可撞线压缩）
      if (this.interruptController.signal.aborted) {
        await emitCompact(false, "用户中断");
        return false;
      }
      this.compactDisabled = true;
      await emitCompact(false, err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /**
   * 组装请求用的消息视图：历史被改写过（裁剪/压缩/超窗剥组）时剥掉 thinking 块再发。
   * 改写后思考对应的现场已不在（工具输出变裁剪标记、消息换摘要），回传思考没有意义，
   * 且改写点之后的请求前缀本已变化，此时剥块保持此后请求前缀稳定；
   * 未改写时原样回传（同模型思考块带签名，续跑校验必需）。切模型不做隐式压缩，
   * 改写与否只看本标记，与目标模型无关。
   * 命令痕迹（source:"command"）不回灌：痕迹只落持久化供界面重演，发给模型会被
   * 当成新的用户请求（实测 /compact 痕迹让模型再跑一遍压缩、跑偏内容混入历史）；
   * 「命令发生过」由摘要元信息（压缩全量读历史，命令痕迹在列）自然带出。
   * @returns 请求用消息数组（未改写时为内部数组的原引用）
   */
  private requestMessages(): Message[] {
    const base = this.historyRewritten
      ? this.messages.map((m) =>
          m.role === "assistant" ? { ...m, content: m.content.filter((b) => b.type !== "thinking") } : m,
        )
      : this.messages;
    return base.filter((m) => !(m.role === "user" && m.source === "command"));
  }

  /**
   * 请求思考等级：历史被改写（thinking 块已剥）时不带。
   * 带 thinking 参数的请求要求最后一条 assistant 以 thinking 块开头（严格校验端点），
   * 剥块后照发会反复 400 烧完重试额度；不带则该轮退回厂商默认思考行为，请求必达。
   * @returns 思考等级；历史被改写过时 undefined
   */
  private contextThinkingLevel(): ThinkingLevel | undefined {
    if (this.historyRewritten) return undefined;
    return this.thinkingLevelRef?.();
  }

  /**
   * 读取并复位「历史被改写」标记（落盘一致性）：压缩/裁剪/超窗剥组
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

  /** 发 Hook 事件但 handler 抛错不影响业务 */
  private async safeEmit(event: HookEvent): Promise<void> {
    if (!this.hooks) return;
    try {
      await this.hooks.emit(event);
    } catch {
      // hook 处理器异常被吞，最多漏该条观测，不中断回合
    }
  }

  /** 镜像 MessageAppended 事件：消息进入上下文时发，轨迹经此获得全部消息全文 */
  private emitMessageAppended(message: Message): Promise<void> {
    return this.safeEmit({
      type: "MessageAppended",
      message,
      agentPath: this.agentPath?.toString() ?? "/root",
    });
  }

  /**
   * 补发崩溃恢复合成消息的 MessageAppended：构造函数不能发射事件，这里统一收口。
   * 逐条同步发射不等待（同 start 的保序说明，订阅方同步记账则到达序=发生序），
   * 调用方须保证在任何新消息发射之前调用（start 的用户消息 / appendCommand 的命令消息 /
   * runTurn 的收件箱注入 / doCompact 的摘要消息），轨迹的消息顺序才与上下文顺序一致。
   */
  private flushPendingRepairMirrors(): void {
    if (this.pendingRepairMirrors.length === 0) return;
    const mirrors = this.pendingRepairMirrors;
    this.pendingRepairMirrors = [];
    for (const message of mirrors) {
      void this.emitMessageAppended(message);
    }
  }

  /** 追加消息并镜像 MessageAppended（异步上下文的消息追加统一走这里） */
  private async appendMessage(message: Message): Promise<void> {
    this.messages.push(message);
    await this.emitMessageAppended(message);
  }

  /**
   * 发 LlmCallEnd 事件：systemPrompt.hash 每次必带，全文仅首次出现
   * 或变更时附带——轨迹据此包含系统提示词各版本全文而不逐条重复。
   * @param fields 调用测量结果（模型、耗时、用量、停因、错误）
   */
  private async emitLlmCallEnd(fields: {
    model: string;
    durationMs: number;
    firstEventMs?: number;
    usage?: ModelUsage;
    stopReason?: string;
    error?: string;
  }): Promise<void> {
    const systemPrompt: { hash: string; content?: string } = { hash: hashText(this.systemPrompt) };
    if (this.emittedSystemPrompt !== this.systemPrompt) {
      systemPrompt.content = this.systemPrompt;
      this.emittedSystemPrompt = this.systemPrompt;
    }
    await this.safeEmit({
      type: "LlmCallEnd",
      agentPath: this.agentPath?.toString() ?? "/root",
      ...fields,
      systemPrompt,
    });
  }

  /** 镜像 PermissionDecision 事件：权限解析汇合后的决策记录 */
  private emitPermissionDecision(
    toolCallId: string,
    toolName: string,
    decision: "allow" | "deny",
    source: "hook" | "rule" | "user",
  ): Promise<void> {
    return this.safeEmit({
      type: "PermissionDecision",
      agentPath: this.agentPath?.toString() ?? "/root",
      toolCallId,
      toolName,
      decision,
      source,
    });
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
    // PreToolUse 在每次工具调用前无条件触发——未知工具/参数校验失败也先发，
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
        await this.emitPermissionDecision(call.id, call.name, result.allowed ? "allow" : "deny", permissionEventSource(result.source));
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
        await this.emitPermissionDecision(call.id, call.name, "deny", "hook");
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
      } else if (hookVerdict === "allow") {
        // 无管线时 hook 显式放行也是一次权限决策，镜像进轨迹
        await this.emitPermissionDecision(call.id, call.name, "allow", "hook");
      }
      // 未知工具：发失败事件（观测闭合：调用开始后必有成功/失败结果）
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
        await this.emitPermissionDecision(call.id, call.name, "deny", "hook");
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
      // 跳过规则/缓存/用户审批，保留 plan 只读约束与 PreToolUse hook 拦截
      const hook = hookVerdict !== undefined ? async (): Promise<PermissionBehavior | undefined> => hookVerdict : undefined;
      const result = tool.skipsPermission
        ? await this.permission.checkSkipsPermission(request, hook)
        : await this.permission.check(request, hook);
      await this.emitPermissionDecision(call.id, call.name, result.allowed ? "allow" : "deny", permissionEventSource(result.source));
      if (!result.allowed) {
        const reason = result.reason ?? "未授权";
        // 权限拒绝：发失败事件（观测闭合）
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
      await this.emitPermissionDecision(call.id, call.name, "deny", "hook");
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
    } else if (hookVerdict === "allow") {
      // 无管线时 hook 显式放行也是一次权限决策，镜像进轨迹
      await this.emitPermissionDecision(call.id, call.name, "allow", "hook");
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
    // 执行耗时起点（durationMs）：从真正开始执行起测——前置（权限/参数）等待不算，
    // 与界面「耗时 x.xs」的展示口径一致；执行前被拒绝的调用没有执行窗口、不带 durationMs
    const executionStartedAt = Date.now();
    try {
      // 工具中断看门狗：interrupt 后工具若不响应 signal（非 bash 类挂起）3s 强制转失败，
      // 与 withInterruptTimeout 配套保证打断后本轮必然收尾；
      // 只读快工具（glob/read/grep 等）另加正常执行超时：本应秒回却挂起不转圈（不依赖打断触发）。
      // 执行超时定时器在 race settle 后清理，残留定时器会拖住 TUI 自然退出
      const execute = tool.isReadOnly ? executeDeadline(this.toolTimeoutMs) : undefined;
      const deadlines: Promise<never>[] = [interruptDeadline(this.interruptController.signal, TOOL_INTERRUPT_TIMEOUT_MS)];
      if (execute) deadlines.push(execute.promise);
      try {
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
        const truncated = spillOutput(output, tool.maxResultSizeChars, this.outputDir, {
          sessionId: this.sessionId,
          toolName: call.name,
        });
        const finalOutput = truncated.content;
        // PostToolUse：工具执行完成（含标记失败的结果），供观测；带执行耗时
        await this.safeEmit({
          type: "PostToolUse",
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
          output: finalOutput,
          isError: Boolean(isError),
          durationMs: Date.now() - executionStartedAt,
          agentPath,
        });
        return {
          message: toolResultMessage(call.id, call.name, finalOutput, isError),
          contextModifier,
        };
      } finally {
        // 无论结果/异常都清理执行超时定时器
        execute?.cancel();
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // PostToolUseFailure：工具执行抛错，供观测；执行中失败带执行窗口耗时
      await this.safeEmit({
        type: "PostToolUseFailure",
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
        error,
        durationMs: Date.now() - executionStartedAt,
        agentPath,
      });
      return {
        message: toolResultMessage(call.id, call.name, `工具 ${call.name} 执行失败：${error}`, true),
      };
    }
  }

  /**
   * PreToolUse Hook 裁决：触发事件总线（每次工具调用前，无条件），
   * 多个 hook 结果聚合为 deny 优先于 ask 优先于 allow（第一个反对即停）；
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
 * 短文本指纹（FNV-1a base36，非安全场景）：LlmCallEnd 的 systemPrompt.hash 用，
 * 标识系统提示词版本（hash 每次必带，全文仅首次或变更时附带）
 */
function hashText(text: string): string {
  let hash = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x1000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * PermissionResult.source → PermissionDecision 事件 source 的三分口径（hook/规则/用户）：
 * hook=钩子裁决；user=用户审批与会话缓存（cache 是用户「允许会话全部」的会话内记忆）；
 * rule=规则层与危险命令/模式/免审批等硬性判定
 */
function permissionEventSource(source: PermissionResult["source"]): "hook" | "rule" | "user" {
  if (source === "hook") return "hook";
  if (source === "approver" || source === "cache") return "user";
  return "rule";
}

/**
 * 修复末尾孤立的工具调用（checkpoint 崩溃恢复）：消息末尾是含工具调用的
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
 * 最后一条 assistant 消息的结论文本（completion watcher 回灌父 agent 用）。
 * 只认最后一条 assistant 消息：向前放宽会把更早轮次的旧文本当结论
 * （子 agent 全程无正文时把第 1 轮开场白当任务结论，父据此误判完成或重派）；
 * 最后一条没有正文（只有 thinking/工具调用）返回空串，回灌文案由调用方决定。
 */
function lastAssistantText(messages: Message[]): string {
  const last = messages.findLast((message) => message.role === "assistant");
  const text = last
    ?.content.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return text && text.trim() ? text : "";
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
    else signal.addEventListener("abort", () => setTimeout(rejectNow, timeoutMs).unref(), { once: true });
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
 * @returns 永不 resolve 的 promise（超时后 reject）与取消函数
 */
export function executeDeadline(timeoutMs: number): { promise: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`工具执行超时：${timeoutMs / 1000}s 未返回`)), timeoutMs);
  });
  // 防 unhandled rejection：Promise.race 已 settle 后迟到触发的 reject 不再报未处理
  promise.catch(() => undefined);
  return {
    promise,
    // race settle（工具返回/中断/超时任一）后清理定时器：残留的 ref'd 定时器会
    // 吊住事件循环，TUI 自然退出（全程无 process.exit）后 shell 提示符延迟最长 60s 才返回
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
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
