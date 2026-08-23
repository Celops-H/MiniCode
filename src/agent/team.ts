/**
 * Team 与线程树（DESIGN 11.1）：注册表持有命名 agent（`path → TeamMember`），
 * root 预注册为协调者（不计数）；spawn 槽位预留/提交/释放防计数泄漏；
 * 并发执行限制器限制同时推进的 agent 数（默认 4）。
 */
import { AgentPath } from "./agent-path.js";
import type { Agent } from "./agent.js";
import type { MailMessage } from "./mailbox.js";

export interface TeamMember {
  /** agent 实例；预留未提交时为 undefined */
  agent: Agent | undefined;
  path: AgentPath;
  parentPath?: AgentPath;
  /** spawn 深度（root=0），递归防护用（DESIGN 11.4 深度默认 1） */
  depth: number;
}

export interface TeamOptions {
  /** spawn 总数上限；缺省不限制 */
  maxAgents?: number;
  /** spawn 深度上限（递归防护）；缺省 1 */
  maxDepth?: number;
  /** 同时推进的 agent 数上限；缺省 4（DESIGN 11.7） */
  maxConcurrent?: number;
}

export class Team {
  private readonly members = new Map<string, TeamMember>();
  private readonly maxAgents: number;
  private readonly maxDepth: number;
  private readonly maxConcurrent: number;
  private spawnCount = 0;
  private activeExecutions = 0;
  /** 并发满时积压的待驱动 agent（槽位释放时重试，防丢唤醒，DESIGN 11.2） */
  private readonly pendingDrives = new Set<Agent>();

  constructor(options: TeamOptions = {}) {
    this.maxAgents = options.maxAgents ?? Infinity;
    this.maxDepth = options.maxDepth ?? 1;
    this.maxConcurrent = options.maxConcurrent ?? 4;
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

  /** 释放已预留或已提交的 spawn：移除路径并退回计数（防泄漏） */
  releaseSpawn(path: AgentPath): void {
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

  /** 消费单个 agent 的续跑循环；结束后释放槽位并重试待驱动队列 */
  private async consumeDriving(agent: Agent, release: () => void): Promise<void> {
    try {
      for await (const _ of agent.resume()) {
        // 消费事件流（驱动推进）
      }
    } catch {
      // 模型流等错误不外泄为未处理 rejection（Node 默认会崩进程）；
      // 工具执行错误已由 executeTool 捕获回灌，这里只兜底驱动路径
    } finally {
      release();
      this.retryPendingDrives();
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