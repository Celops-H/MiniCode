/**
 * Team 与线程树（DESIGN 11.1）：注册表持有命名 agent（`path → TeamMember`），
 * root 预注册为协调者（不计数）；spawn 槽位预留/提交/释放防计数泄漏；
 * 并发执行限制器限制同时推进的 agent 数（默认 4）。
 */
import { AgentPath } from "./agent-path.js";
import type { Agent } from "./agent.js";
import type { StreamEvent } from "../core/index.js";
import type { MailMessage } from "./mailbox.js";
import { abortWorktree, completeWorktree, createWorktree, resolveGitRoot, type WorktreeInfo } from "./worktree.js";

export interface TeamMember {
  /** agent 实例；预留未提交时为 undefined */
  agent: Agent | undefined;
  path: AgentPath;
  parentPath?: AgentPath;
  /** spawn 深度（root=0），递归防护用（DESIGN 11.4 深度默认 1） */
  depth: number;
  /** Git Worktree 信息（worktrees 开启且为 git 仓库时）：并行隔离的工作区与分支（DESIGN 4.2） */
  worktree?: WorktreeInfo;
}

export interface TeamOptions {
  /** spawn 总数上限；缺省不限制 */
  maxAgents?: number;
  /** spawn 深度上限（递归防护）；缺省 1 */
  maxDepth?: number;
  /** 同时推进的 agent 数上限；缺省 4（DESIGN 11.7） */
  maxConcurrent?: number;
  /** 启用 Git Worktree 隔离：子 agent 各自独立工作区（DESIGN 4.2）；非 git 仓库时自动忽略 */
  worktrees?: boolean;
  /** root 被后台驱动（子 agent 完成唤醒续跑）时的事件转发（CLI 渲染 root 迟到结论用，review 修复） */
  onRootEvent?: (event: StreamEvent) => void;
}

export class Team {
  private readonly members = new Map<string, TeamMember>();
  private readonly maxAgents: number;
  private readonly maxDepth: number;
  private readonly maxConcurrent: number;
  private readonly worktrees: boolean;
  private readonly onRootEvent: ((event: StreamEvent) => void) | undefined;
  private spawnCount = 0;
  private activeExecutions = 0;
  /** 并发满时积压的待驱动 agent（槽位释放时重试，防丢唤醒，DESIGN 11.2） */
  private readonly pendingDrives = new Set<Agent>();

  constructor(options: TeamOptions = {}) {
    this.maxAgents = options.maxAgents ?? Infinity;
    this.maxDepth = options.maxDepth ?? 1;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.worktrees = options.worktrees ?? false;
    this.onRootEvent = options.onRootEvent;
  }

  /**
   * 为子 agent 创建 Git Worktree（worktrees 开启且父在 git 仓库内时）：
   * 子 agent 独立工作区 + 独立分支，文件写物理隔离（DESIGN 4.2）。
   * 创建成功后记录到对应 member（commitSpawn 后即可用，release 时自动清理）。
   * @param parentPath 父 agent 路径
   * @param agentName 子 agent 名
   * @returns worktree 信息；不可用（未开启/非 git 仓库）返回 undefined
   */
  createChildWorktree(parentPath: AgentPath, agentName: string): WorktreeInfo | undefined {
    if (!this.worktrees) return undefined;
    const parent = this.members.get(parentPath.toString())?.agent;
    if (!parent) return undefined;
    const rootDir = resolveGitRoot(parent.getCwd());
    if (!rootDir) return undefined; // 非 git 仓库：退化为共享目录 + CAS 冲突防护
    const info = createWorktree(rootDir, agentName);
    if (!info) return undefined;
    const childPath = parentPath.join(agentName);
    if (typeof childPath !== "string") {
      const member = this.members.get(childPath.toString());
      if (member) member.worktree = info;
    }
    return info;
  }

  /**
   * 子 agent 终态（自然完成）时合并其 worktree 分支。
   * 合并成功/无改动才清空 member.worktree（终态）；冲突/失败保留（kept）——
   * 子 agent 解决冲突后再完成时，本函数再次执行即重试合并（review 修复：原实现无条件清空，
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

  /** 注册根 agent（协调者，路径固定 `/root`，不占 spawn 计数） */
  registerRoot(agent: Agent): void {
    const root = AgentPath.root();
    agent.agentPath = root;
    this.members.set(root.toString(), { agent, path: root, depth: 0 });
  }

  /**
   * 预留 spawn 槽位：校验父存在、深度上限、路径唯一、总数上限，并占用路径。
   * 提交用 commitSpawn；不提交时调用方应 releaseSpawn 释放（防计数/路径泄漏）。
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
    if (this.spawnCount >= this.maxAgents) return `agent 总数超限：最多 ${this.maxAgents} 个`;
    // 预留即占槽位（防「只预留不提交」绕过上限），commit 只填实例，release 退回
    this.spawnCount++;
    this.members.set(child.toString(), { agent: undefined, path: child, parentPath, depth });
    return child;
  }

  /** 提交已预留的 spawn：填入 agent 实例并记录其路径（计数已在预留时占用） */
  commitSpawn(path: AgentPath, agent: Agent): void {
    const member = this.members.get(path.toString());
    if (!member) return;
    member.agent = agent;
    agent.agentPath = path;
  }

  /** 释放已预留或已提交的 spawn：移除路径并退回计数（防泄漏）；有 worktree 时一并清理 */
  releaseSpawn(path: AgentPath): void {
    const member = this.members.get(path.toString());
    if (member?.worktree) {
      this.abortChildWorktree(path);
    }
    if (this.members.delete(path.toString())) {
      this.spawnCount--;
    }
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
   * 投递消息到目标 agent 邮箱（DESIGN 11.3）。
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

  /** 后台驱动单个 agent 续跑：并发槽位内消费其 resume()（DESIGN 11.2 唤醒已结束 agent） */
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
    try {
      // root 被后台驱动（如子 agent 完成唤醒续跑）时事件无人渲染——
      // 转发给 onRootEvent（宿主 CLI 渲染 root 迟到结论），否则汇总结论被消费丢弃（review 修复）
      const isRoot = agent.agentPath?.isRoot() ?? false;
      for await (const event of agent.resume()) {
        if (isRoot) {
          try {
            this.onRootEvent?.(event);
          } catch {
            // 渲染回调抛错不中止驱动推进（review 修复：原实现回调抛错中止事件流、结论截断）
          }
        }
      }
    } catch {
      // 模型流等错误不外泄为未处理 rejection（Node 默认会崩进程）；
      // 工具执行错误已由 executeTool 捕获回灌，这里只兜底驱动路径
    } finally {
      release();
      this.retryPendingDrives();
    }
    await this.notifyCompletion(agent);
  }

  /**
   * completion watcher（DESIGN 11.5）：子 agent 达到终态（resume 结束）时，
   * 把其结论以 FINAL_ANSWER 回灌父 agent（triggerTurn 唤醒父），是父拿结论的唯一来源。
   * wait_agent 只挂起不消费结论，避免重复投递。
   */
  private async notifyCompletion(agent: Agent): Promise<void> {
    const path = agent.agentPath;
    if (!path) return;
    const parentPath = this.members.get(path.toString())?.parentPath;
    if (!parentPath) return; // root 无父，无需回灌
    if (agent.isActive()) return; // 期间又被驱动（新任务），让新循环结束时再回灌
    if (agent.isInterrupted()) {
      // 被中断：显式动作，调用方已知，不投中途文本当结论。
      // 不清理 worktree——后续 followup 可复活续用（DESIGN 11.2），目录/分支/注册均保留
      return;
    }
    // 自然完成：合并 worktree 分支进主分支（DESIGN 4.2），合并结果附在结论前提示父
    const mergeMessage = this.completeChildWorktree(path);
    const content = mergeMessage
      ? `${mergeMessage}。\n${agent.conclusionText()}`
      : agent.conclusionText();
    await this.sendMessage(parentPath, {
      type: "FINAL_ANSWER",
      from: path,
      content,
      triggerTurn: true,
    });
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
   * 获取并发执行槽位（开 turn 才占容量，DESIGN 11.2）。
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