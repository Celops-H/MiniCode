/**
 * Team 与线程树：注册表持有命名 agent（`path → TeamMember`），
 * root 预注册为协调者；spawn 槽位预留/提交/释放防路径泄漏；
 * 并发执行限制器限制同时推进的 agent 数（默认 4）。
 */
import { AgentPath } from "./agent-path.js";
import type { Agent } from "./agent.js";
import type { StreamEvent } from "../core/index.js";
import type { HookBus } from "../hooks/index.js";
import type { MailMessage } from "./mailbox.js";
import { abortWorktree, completeWorktree, createWorktree, resolveGitRoot, type WorktreeInfo } from "./worktree.js";

/** 路径末段（展示名）：/root/task_1 → task_1（失败回灌文案用） */
function agentNameOf(path: AgentPath): string {
  return path.toString().split("/").filter(Boolean).at(-1) ?? path.toString();
}

/** 工具调用标记特征：模型失配时会把厂商私有的工具调用标记原文吐进正文
 *  （deepseek-v4 实测样本形如 `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read">`）。
 *  只收带特殊字符的私有标记，通用写法（如 <tool_call>）正文可能合法讨论，不收防误伤 */
const TOOL_CALL_MARKUP: RegExp[] = [/<｜｜DSML｜｜/, /<｜tool▁calls▁begin｜>/];

/** 结论是否命中工具调用标记特征（命中即判定模型失配、结论不可信） */
function looksLikeRawToolCallMarkup(text: string): boolean {
  return TOOL_CALL_MARKUP.some((pattern) => pattern.test(text));
}

export interface TeamMember {
  /** agent 实例；预留未提交时为 undefined */
  agent: Agent | undefined;
  path: AgentPath;
  parentPath?: AgentPath;
  /** spawn 深度（root=0），递归防护用（深度默认 2） */
  depth: number;
  /** Git Worktree 信息（worktrees 开启且为 git 仓库时）：并行隔离的工作区与分支 */
  worktree?: WorktreeInfo;
}

export interface TeamOptions {
  /** spawn 深度上限（root=0，递归防护）；缺省 2（main→子→孙） */
  maxDepth?: number;
  /** 同时推进的 agent 数上限；缺省 4 */
  maxConcurrent?: number;
  /** 启用 Git Worktree 隔离：子 agent 各自独立工作区；非 git 仓库时自动忽略 */
  worktrees?: boolean;
  /** root 被后台驱动（子 agent 完成唤醒续跑）时的事件转发（TUI 渲染 root 迟到结论用） */
  onRootEvent?: (event: StreamEvent) => void;
  /** Hook 总线（子 agent 生命周期事件触发通道）；缺省不触发 */
  hooks?: HookBus;
}

export class Team {
  private readonly members = new Map<string, TeamMember>();
  private readonly maxDepth: number;
  private readonly maxConcurrent: number;
  private readonly worktrees: boolean;
  private readonly onRootEvent: ((event: StreamEvent) => void) | undefined;
  private readonly hooks: HookBus | undefined;
  private activeExecutions = 0;
  /** 并发满时积压的待驱动 agent（槽位释放时重试，防丢唤醒） */
  private readonly pendingDrives = new Set<Agent>();

  constructor(options: TeamOptions = {}) {
    this.maxDepth = options.maxDepth ?? 2;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.worktrees = options.worktrees ?? false;
    this.onRootEvent = options.onRootEvent;
    this.hooks = options.hooks;
  }

  /**
   * 为子 agent 创建 Git Worktree：子 agent 独立工作区 + 独立分支，文件写物理隔离。
   * 是否启用按调用方传入的开关（spawn 派生时的逐次选择），
   * 未传时回落 Team 全局缺省（装配层从 config.worktrees 注入）。
   * 创建成功后记录到对应 member（commitSpawn 后即可用，release 时自动清理）。
   * @param childPath 子 agent 完整路径（worktree 目录/分支名的唯一段）
   * @param enabled 是否启用隔离；缺省随 Team 全局缺省
   * @returns worktree 信息；不可用（未开启/非 git 仓库/创建失败）返回 undefined
   */
  createChildWorktree(childPath: AgentPath, enabled?: boolean): WorktreeInfo | undefined {
    if (!(enabled ?? this.worktrees)) return undefined;
    const parent = this.members.get(childPath.parent().toString())?.agent;
    if (!parent) return undefined;
    const rootDir = resolveGitRoot(parent.getCwd());
    if (!rootDir) return undefined; // 非 git 仓库：退化为共享目录 + CAS 冲突防护
    const info = createWorktree(rootDir, childPath.toString());
    if (!info) return undefined;
    const member = this.members.get(childPath.toString());
    if (member) member.worktree = info;
    return info;
  }

  /** Team 全局 worktree 缺省开关（spawn 工具 worktree 参数的缺省值） */
  get worktreeDefault(): boolean {
    return this.worktrees;
  }

  /** 查询子 agent 当前挂着的 worktree（spawn 结果判定隔离是否生效用） */
  getWorktree(path: AgentPath): WorktreeInfo | undefined {
    return this.members.get(path.toString())?.worktree;
  }

  /**
   * 子 agent 终态（自然完成）时合并其 worktree 分支。
   * 合并成功/无改动才清空 member.worktree（终态）；冲突/失败保留（kept）——
   * 子 agent 解决冲突后再完成时，本函数再次执行即重试合并（原实现无条件清空，
   * 使「冲突 agent 自解」闭环不可达，保留的 worktree 成孤儿）
   */
  completeChildWorktree(path: AgentPath): string | undefined {
    const member = this.members.get(path.toString());
    if (!member?.worktree) return undefined;
    const parent = member.parentPath ? this.members.get(member.parentPath.toString())?.agent : undefined;
    const rootDir = parent ? resolveGitRoot(parent.getCwd()) : undefined;
    if (!rootDir) return `合并失败：无法定位仓库根`;
    const result = completeWorktree(rootDir, member.worktree);
    if (result.status === "merged" || result.status === "no_changes") {
      member.worktree = undefined;
    }
    return result.message;
  }

  /** 子 agent 中断/异常时清理 worktree 目录（分支保留在仓库） */
  abortChildWorktree(path: AgentPath): void {
    const member = this.members.get(path.toString());
    if (!member?.worktree) return;
    const parent = member.parentPath ? this.members.get(member.parentPath.toString())?.agent : undefined;
    const rootDir = parent ? resolveGitRoot(parent.getCwd()) : undefined;
    if (!rootDir) return;
    abortWorktree(rootDir, member.worktree);
    member.worktree = undefined;
  }

  /** 注册根 agent（协调者，路径固定 `/root`） */
  registerRoot(agent: Agent): void {
    const root = AgentPath.root();
    agent.agentPath = root;
    this.members.set(root.toString(), { agent, path: root, depth: 0 });
  }

  /**
   * 预留 spawn 槽位：校验父存在、深度上限、路径唯一，并占用路径。
   * 提交用 commitSpawn；不提交时调用方应 releaseSpawn 释放（防路径泄漏）。
   * @param parentPath 父 agent 路径
   * @param agentName 子 agent 名（路径末段）
   * @returns 子路径（可直接作 spawn 目标）或错误文本
   */
  reserveSpawn(parentPath: AgentPath, agentName: string): AgentPath | string {
    const parent = this.members.get(parentPath.toString());
    if (!parent) return `父 agent 路径 ${parentPath} 不存在`;
    const depth = parent.depth + 1;
    if (depth > this.maxDepth) return `spawn 深度超限：最多 ${this.maxDepth} 层`;
    const child = parentPath.join(agentName);
    if (typeof child === "string") return child;
    if (this.members.has(child.toString())) return `agent 路径 ${child} 已存在`;
    // 预留即占路径（防「只预留不提交」绕过唯一性），commit 只填实例，release 释放
    this.members.set(child.toString(), { agent: undefined, path: child, parentPath, depth });
    return child;
  }

  /** 提交已预留的 spawn：填入 agent 实例并记录其路径（路径已在预留时占用）。
   *  派生观测事件（AgentSpawned）由驱动层（consumeDriving）发射——初次派生与 followup 唤醒
   *  都经后台驱动续跑，统一在驱动起点发，避免 commitSpawn 发一次、唤醒又发一次的重复。 */
  commitSpawn(path: AgentPath, agent: Agent): void {
    const member = this.members.get(path.toString());
    if (!member) return;
    member.agent = agent;
    agent.agentPath = path;
  }

  /** 释放已预留或已提交的 spawn：移除路径（防泄漏）；有 worktree 时一并清理 */
  releaseSpawn(path: AgentPath): void {
    const member = this.members.get(path.toString());
    if (member?.worktree) {
      this.abortChildWorktree(path);
    }
    this.members.delete(path.toString());
  }

  /** 按路径查 agent（含 root；预留未提交时 agent 为 undefined） */
  resolveAgent(path: AgentPath): TeamMember | undefined {
    return this.members.get(path.toString());
  }

  /** 列出全部活跃子 agent（不含 root） */
  listAgents(): TeamMember[] {
    return [...this.members.values()].filter((member) => !member.path.isRoot());
  }

  /**
   * 级联中断全部子 agent（Esc 打断 / 退出前兜底）：对每个持有 agent 的成员调 interrupt，
   * 让活跃的 resume 循环尽快收尾（模型流/工具执行中止、不再产出新事件），root 同样被中断。
   */
  interruptAll(): void {
    for (const member of this.members.values()) {
      member.agent?.interrupt();
    }
  }

  /**
   * 会话收尾清理（SessionEnd 后调用）：中断全部活跃 agent、清空注册表/待驱动队列。
   * 防后台 resume 循环吊住进程不退，成员记录也不泄漏到下一生命周期。
   */
  clear(): void {
    this.interruptAll();
    // 子 agent 会话补结束标记（中断收尾）：收尾后注册表即清空，终态回调只补发
    // 中断事件、不再写子会话标记（见 notifyCompletion），这里在清理前补写；
    // 已写过终态标记的不覆盖（防把已完成错改成中断）。异步不等完成，失败只丢标记不丢消息
    for (const member of this.members.values()) {
      member.agent?.finalizeOwnSession("interrupted", { onlyIfUnended: true }).catch(() => undefined);
    }
    // 先按 releaseSpawn 同款清理各成员挂的 worktree（避免 clear 绕过清理变孤儿目录），再清注册表
    for (const member of [...this.members.values()]) {
      if (member.worktree) this.abortChildWorktree(member.path);
      // 清收件箱：排队消息会让中断的 agent 在 resume 里复活续跑，退出时进程不被吊住
      member.agent?.clearMailbox();
    }
    this.members.clear();
    this.pendingDrives.clear();
    // activeExecutions 不显式归零：driveAgent 是即发即忘的后台驱动，clear 时通常有在途 consumeDriving
    // 循环持槽位，其 finally 的 release() 会自然排干计数；显式归零会让迟到 release 把计数减成负数（并发槽位失真）
  }

  /**
   * 投递消息到目标 agent 邮箱。
   * 唤醒型消息（triggerTurn）投递后立即后台驱动目标续跑，不阻塞投递方
   * （对齐投递 → 通知 → 目标续跑语义；并发满时留待下次投递驱动）。
   * @param target 目标 agent 路径
   * @param mail 待投递消息
   * @returns 目标不存在时返回错误文本，成功返回 undefined
   */
  async sendMessage(target: AgentPath, mail: MailMessage): Promise<string | undefined> {
    const member = this.members.get(target.toString());
    if (!member?.agent) return `目标 agent ${target} 不存在`;
    member.agent.deliver(mail);
    if (mail.triggerTurn) {
      void this.driveAgent(member.agent);
    }
    return undefined;
  }

  /** 后台驱动单个 agent 续跑：并发槽位内消费其 resume()（唤醒已结束 agent） */
  private async driveAgent(agent: Agent): Promise<void> {
    // 忙（已有活跃续跑循环）：不重复驱动，活跃循环会在每轮结束自行消费收件箱消息
    if (agent.isActive()) return;
    const release = this.acquireExecution();
    if (typeof release === "string") {
      // 并发满：进待驱动队列，槽位释放时重试（防丢唤醒）
      this.pendingDrives.add(agent);
      return;
    }
    await this.consumeDriving(agent, release);
  }

  /** 消费单个 agent 的续跑循环；结束后释放槽位、重试待驱动队列并回灌结论（watcher） */
  private async consumeDriving(agent: Agent, release: () => void): Promise<void> {
    // 驱动失败捕获：模型流失败等错误不再吞掉——带失败语义回灌，父 agent 拿到
    // 明确失败文本而不是半截文本/「未产出结论」当结论
    let failure: unknown;
    try {
      // 后台驱动起点发派生观测事件：初次派生与 followup 唤醒都经这里——
      // TUI 树靠该事件把条目置为运行态（唤醒一个已完成/中断的 agent 时树重新亮起）；
      // root 恒常驻不发（否则每次子完成回灌唤醒 root 都会误发一次「派生」）
      const path = agent.agentPath;
      const parentPath = path ? this.members.get(path.toString())?.parentPath : undefined;
      if (path && !path.isRoot() && parentPath) {
        await this.safeEmit({
          type: "AgentSpawned",
          path: path.toString(),
          parentPath: parentPath.toString(),
          ...(agent.isReadOnly() ? { readOnly: true } : {}),
        });
      }
      // root 被后台驱动（如子 agent 完成唤醒续跑）时事件无人渲染——
      // 转发给 onRootEvent（宿主渲染 root 迟到结论），否则汇总结论被消费丢弃
      const isRoot = agent.agentPath?.isRoot() ?? false;
      for await (const event of agent.resume()) {
        if (isRoot) {
          try {
            this.onRootEvent?.(event);
          } catch {
            // 渲染回调抛错不中止驱动推进（原实现回调抛错中止事件流、结论截断）
          }
        }
      }
    } catch (err) {
      // 驱动路径兜底：错误不外泄为未处理 rejection（Node 默认会崩进程），
      // 记为失败终态交 notifyCompletion 处理；工具执行错误已由 executeTool 捕获回灌
      failure = err;
    } finally {
      release();
      this.retryPendingDrives();
    }
    await this.notifyCompletion(agent, failure);
  }

  /**
   * completion watcher：子 agent 达到终态（resume 结束）时，
   * 把其结论以 FINAL_ANSWER 回灌父 agent（triggerTurn 唤醒父），是父拿结论的唯一来源。
   * 被中断时不投结论，只排队中断标记不唤醒（INTERRUPTED 类型，见中断分支）。
   * wait_agent 只挂起不消费结论，避免重复投递。
   * @param agent 完成的子 agent
   * @param failure 驱动失败：非 undefined 时走失败终态——不合并 worktree、
   *   回灌明确失败文本（半截文本/「未产出结论」不再被当结论误导父 agent）
   */
  private async notifyCompletion(agent: Agent, failure?: unknown): Promise<void> {
    const path = agent.agentPath;
    if (!path) return;
    const member = this.members.get(path.toString());
    if (!member) {
      // 会话收尾（clear 清空注册表）后在途驱动才收尾：成员与父记录已查不到。
      // 终态事件仍要发，否则轨迹里该子 agent 只有 AgentSpawned 无终态行，
      // 按 agent 统计终态出现缺口。收尾窗口内无法区分真实终态：interruptAll
      // 已把成员的中断标记置位，中断引发的流中止错误也表现为驱动失败，
      // 刚自然完成、回调尚未跑到的窄窗口同样不可分辨——统一按中断口径补发；
      // 父多半也已清空，不投递标记消息（sendMessage 只会报目标不存在）；
      // 子会话结束标记已由 clear 兜底写过，这里不重复收尾
      if (path.isRoot()) return;
      await this.safeEmit({
        type: "AgentInterrupted",
        path: path.toString(),
        parentPath: path.parent().toString(),
      });
      return;
    }
    const parentPath = member.parentPath;
    if (!parentPath) return; // root 无父，无需回灌
    if (agent.isActive()) return; // 期间又被驱动（新任务），让新循环结束时再回灌
    const name = agentNameOf(path);
    // 子 agent 会话收尾：按终态写结束标记（结论不可信按失败记，与回灌口径一致）。
    // 收尾失败不阻断结论回灌（落盘故障只丢标记不丢消息，消息已随轮 flush）
    const endReason = agent.isInterrupted()
      ? "interrupted"
      : failure !== undefined || looksLikeRawToolCallMarkup(agent.conclusionText())
        ? "failed"
        : "completed";
    try {
      await agent.finalizeOwnSession(endReason);
    } catch {
      // 落盘故障静默：结论回灌与观测事件不受影响
    }
    if (agent.isInterrupted()) {
      // 被中断：显式动作，不投中途文本当结论，只回灌「已中断」标记让父知晓任务未完成。
      // 用 INTERRUPTED 类型只排队不唤醒、不参与父的续跑判定：中断多来自 Esc 级联
      // （父同时被打断），标记若参与续跑判定，父 unwind 窗口内到达会顶着打断意图
      // 重启父；标记留在收件箱，父下次输入时消费。不清理 worktree——后续 followup
      // 可复活续用，目录/分支/注册均保留
      await this.safeEmit({
        type: "AgentInterrupted",
        path: path.toString(),
        parentPath: parentPath.toString(),
      });
      await this.sendMessage(parentPath, {
        type: "INTERRUPTED",
        from: path,
        content: `子代理 ${name} 已中断，任务未完成。可对其发消息唤醒续跑（原路径保留），或放弃该子任务。`,
        triggerTurn: false,
      });
      return;
    }
    if (failure !== undefined) {
      // 失败终态：模型链耗尽等驱动失败——不合并 worktree（产出不完整），
      // 回灌明确失败文本让父 agent 决定重试或调整，不拿半截文本当结论
      const message = failure instanceof Error ? failure.message : String(failure);
      await this.safeEmit({
        type: "AgentCompleted",
        path: path.toString(),
        parentPath: parentPath.toString(),
        conclusion: `子代理 ${name} 失败：${message}`,
        failed: true,
      });
      await this.sendMessage(parentPath, {
        type: "FINAL_ANSWER",
        from: path,
        content: `子代理 ${name} 执行失败（${message}），任务未完成。可换名重新 spawn 重试（原路径保留未释放），或放弃该子任务。`,
        triggerTurn: true,
      });
      return;
    }
    // 结论可信度闸：正文命中厂商私有工具调用标记，判定模型失配把工具调用原文
    // 吐成了正文，按不可信失败处理（不合并 worktree，产出不完整）
    const conclusion = agent.conclusionText();
    if (looksLikeRawToolCallMarkup(conclusion)) {
      const reason = "结论命中工具调用标记，判定模型失配把工具调用原文吐进了正文";
      await this.safeEmit({
        type: "AgentCompleted",
        path: path.toString(),
        parentPath: parentPath.toString(),
        conclusion: `子代理 ${name} 结论不可信：${reason}`,
        failed: true,
      });
      await this.sendMessage(parentPath, {
        type: "FINAL_ANSWER",
        from: path,
        content: `子代理 ${name} 产出不可信（${reason}），任务未完成。可换名重新 spawn 重试（原路径保留未释放），或放弃该子任务。`,
        triggerTurn: true,
      });
      return;
    }
    // 自然完成：合并 worktree 分支进主分支；空结论回灌占位说明。
    // 事件 conclusion 保留原值（可空串，TUI 据此显示警示行、轨迹保留原貌），
    // 回灌父的文案带合并提示前缀（父需要知道 worktree 产出已进自己工作区）
    const mergeMessage = this.completeChildWorktree(path);
    const mailContent = mergeMessage
      ? `${mergeMessage}。\n${conclusion || "(子代理未产出结论)"}`
      : conclusion || "(子代理未产出结论)";
    await this.safeEmit({
      type: "AgentCompleted",
      path: path.toString(),
      parentPath: parentPath.toString(),
      conclusion,
      mergeResult: mergeMessage,
    });
    await this.sendMessage(parentPath, {
      type: "FINAL_ANSWER",
      from: path,
      content: mailContent,
      triggerTurn: true,
    });
  }

  /** 观测事件安全触发：handler 抛错不影响结论回灌与驱动流程（未处理 rejection 会崩进程） */
  private async safeEmit(event: Parameters<HookBus["emit"]>[0]): Promise<void> {
    try {
      await this.hooks?.emit(event);
    } catch {
      // 观测事件失败静默忽略（与 onRootEvent 的渲染回调防护一致）
    }
  }

  /** 槽位释放后重试待驱动队列：逐个获取槽位并后台驱动；槽位仍满则留给下次释放 */
  private retryPendingDrives(): void {
    for (const agent of [...this.pendingDrives]) {
      if (agent.isActive()) {
        // 已被活跃循环接管（如期间收到用户输入），无需再驱动
        this.pendingDrives.delete(agent);
        continue;
      }
      const release = this.acquireExecution();
      if (typeof release === "string") return;
      this.pendingDrives.delete(agent);
      void this.consumeDriving(agent, release);
    }
  }

  /**
   * 获取并发执行槽位（开 turn 才占容量）。
   * @returns 释放函数（RAII 语义，调用一次即释放）；超出上限返回错误文本
   */
  acquireExecution(): (() => void) | string {
    if (this.activeExecutions >= this.maxConcurrent) {
      return `并发 agent 数超限：最多 ${this.maxConcurrent} 个同时推进`;
    }
    this.activeExecutions++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeExecutions--;
      }
    };
  }
}