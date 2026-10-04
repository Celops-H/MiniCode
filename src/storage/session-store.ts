import { readFile, writeFile, readdir, mkdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Message, ModelUsage } from "../core/index.js";
import { appendJsonlBatch, readJsonl } from "./jsonl.js";
import { Session, DEFAULT_SESSION_TITLE, type SessionMeta, type SessionListItem } from "./session.js";

/**
 * 会话存储：消息以 JSONL 一行一条落盘（唯一数据源），元数据独立成文件便于索引。
 * 目录约定：<id>.jsonl（消息）、<id>.meta.json（元数据）。
 * write-behind 攒批：appendMessage 只更新内存，flush() 统一批量落盘，
 * 避免每条消息逐次 I/O 与重写 meta 文件的写放大。
 * 并发子 agent 共享同一 store 实例：flush/rewrite/finalize/delete 走串行链
 * 执行，否则重叠执行会把同一批 pending 消息重复追加进 JSONL。
 */
export class SessionStore {
  private readonly dir: string;
  /** 待 flush 落盘的消息（按会话攒批） */
  private readonly pending = new Map<string, { session: Session; messages: Message[] }>();
  /** 本次进程内新增的用量增量（按会话攒批，flush 时并入 meta.summary.usage）。
   *  压缩重写会丢消息但 usage 是累计值，不能从消息重算，只能增量记账 */
  private readonly usageDelta = new Map<string, ModelUsage>();
  /** 本次进程内见过的最新停因（按会话记，flush 时写入 meta.summary.lastStopReason） */
  private readonly stopReasons = new Map<string, string>();
  /** flush/rewrite/finalize 串行链：并发触发排队执行，链上任务自身不再走 flush()（会死锁） */
  private flushChain: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  private messageFile(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  private metaFile(id: string): string {
    return path.join(this.dir, `${id}.meta.json`);
  }

  /** 确保存储目录存在（写操作前调用）。POSIX 700：会话内容属用户隐私，不向同机其他用户开放 */
  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  /**
   * 新建会话并落盘元数据。
   * @param options 会话参数（模型 id、可选标题）
   * @returns 新建的会话
   */
  async createSession(options: { model: string; title?: string }): Promise<Session> {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: randomUUID(),
      title: options.title ?? DEFAULT_SESSION_TITLE,
      model: options.model,
      createdAt: now,
      updatedAt: now,
      formatVersion: 1,
    };
    await this.ensureDir();
    await writeFile(this.metaFile(meta.id), JSON.stringify(meta, null, 2), { mode: 0o600, encoding: "utf8" });
    return new Session(meta);
  }

  /**
   * 新建子 agent 会话：独立消息文件，meta 标记 kind/父会话/agent 路径。
   * 列表（listSessions）不展示子会话，删除随主会话级联。
   * @param options 子会话参数（主会话 id 必填：级联删除与归属靠它定位，
   *   缺父会话的子会话会成无管理入口的孤儿）
   * @returns 新建的子会话
   */
  async createSubagentSession(options: {
    parentSessionId: string;
    agentPath: string;
    model: string;
  }): Promise<Session> {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: randomUUID(),
      title: options.agentPath,
      model: options.model,
      createdAt: now,
      updatedAt: now,
      formatVersion: 1,
      kind: "subagent",
      parentSessionId: options.parentSessionId,
      agentPath: options.agentPath,
    };
    await this.ensureDir();
    await writeFile(this.metaFile(meta.id), JSON.stringify(meta, null, 2), { mode: 0o600, encoding: "utf8" });
    return new Session(meta);
  }

  /**
   * 加载会话：读取元数据与全部消息，重建 Session。
   * @param id 会话 id
   * @returns 重建的会话
   */
  async loadSession(id: string): Promise<Session> {
    const raw = await readFile(this.metaFile(id), "utf8");
    const parsed = JSON.parse(raw) as SessionMeta;
    // 最小形状校验：listSessions 有形状检查而这里没有，坏 meta 照加载——缺 id
    // 续聊后以 undefined 为攒批键静默写出 undefined.jsonl；显式报错让用户可定位坏文件
    if (typeof parsed?.id !== "string" || parsed.id.length === 0) {
      throw new Error(`会话元数据损坏（${id}.meta.json 缺少会话 id）：无法加载，可删除该会话文件后重建`);
    }
    if (parsed.id !== id) {
      // meta.id 与文件名不一致（手改/拷贝改名）：后续 flush 会按 meta.id 写出另一对文件
      throw new Error(`会话元数据损坏（${id}.meta.json 的 id 与文件名不一致）：无法加载，可删除该会话文件后重建`);
    }
    // 旧会话无 formatVersion 字段，视为版本 1
    const meta: SessionMeta = { ...parsed, formatVersion: parsed.formatVersion ?? 1 };
    const messages = await readJsonl<Message>(this.messageFile(id));
    return new Session(meta, messages);
  }

  /**
   * 追加一条消息到会话内存并记入攒批队列；flush() 时批量落盘。
   * assistant 消息同时记账用量增量与最新停因（flush 时并入会话级汇总）。
   * @param session 目标会话
   * @param message 待追加的消息
   */
  async appendMessage(session: Session, message: Message): Promise<void> {
    session.append(message);
    session.meta.updatedAt = new Date().toISOString();
    if (message.role === "assistant" && message.meta) {
      const id = session.meta.id;
      if (message.meta.usage) {
        this.usageDelta.set(id, addUsage(this.usageDelta.get(id), message.meta.usage));
      }
      if (message.meta.stopReason) {
        this.stopReasons.set(id, message.meta.stopReason);
      }
    }
    const entry = this.pending.get(session.meta.id) ?? { session, messages: [] };
    entry.messages.push(message);
    this.pending.set(session.meta.id, entry);
  }

  /**
   * 强制落盘：把攒批的消息一次 append 写 JSONL，并写回已变更的会话元数据。
   * 交互关键节点调用（flush 屏障），保证崩溃时已完成回合的消息不丢。
   */
  async flush(): Promise<void> {
    const run = this.flushChain.then(() => this.flushPending());
    this.flushChain = run.catch(() => undefined);
    await run;
  }

  /** flush 主体（串行链上执行）：消息批量落盘 + 汇总并入 meta */
  private async flushPending(): Promise<void> {
    if (this.pending.size === 0) return;
    await this.ensureDir();
    for (const [id, { session }] of [...this.pending]) {
      // 同步取走整批与账目（取走与删除之间无 await，原子）：此后并发 appendMessage
      // 新建的批次与本批互不干扰，落盘 await 期间新增的消息与用量不会被本批吞掉
      const entry = this.pending.get(id)!;
      this.pending.delete(id);
      const delta = this.usageDelta.get(id);
      const stopReason = this.stopReasons.get(id);
      this.usageDelta.delete(id);
      this.stopReasons.delete(id);
      try {
        await appendJsonlBatch(this.messageFile(id), entry.messages);
      } catch (err) {
        // 落盘失败整批退回（新批次在前，旧批次在后），账目一并退回，重试 flush 补写
        const fresh = this.pending.get(id);
        if (fresh) fresh.messages.unshift(...entry.messages);
        else this.pending.set(id, { session, messages: entry.messages });
        if (delta) this.usageDelta.set(id, addUsage(delta, this.usageDelta.get(id)));
        if (stopReason) this.stopReasons.set(id, stopReason);
        throw err;
      }
      // 会话级汇总并账 + meta 写盘：meta 写失败时消息已落盘不重灌（防重复追加），
      // 账已并入内存 summary，下次 flush 重写 meta 自然带上，不会重复累计
      const summary = session.meta.summary ?? { messageCount: 0, usage: {} };
      summary.messageCount = session.getMessages().length;
      summary.usage = addUsage(summary.usage, delta);
      if (stopReason) summary.lastStopReason = stopReason;
      session.meta.summary = summary;
      await writeFile(this.metaFile(id), JSON.stringify(session.meta, null, 2), { mode: 0o600, encoding: "utf8" });
    }
  }

  /**
   * 重写会话整份消息（/compact 压缩替换后调用）：临时文件 + 原子改名替换 JSONL，
   * 保证单一数据源与内存一致；同时更新会话内存与元数据时间。
   * @param session 目标会话
   * @param messages 新消息数组（压缩后的完整消息）
   */
  async rewriteMessages(session: Session, messages: Message[]): Promise<void> {
    // 快照在排队前（调用时刻）：此刻已入队未落盘的消息为旧消息，重写时丢弃；
    // 排队与 IO 期间并发 append 的新消息不在快照内，重写后保留
    const staleIds = new Set(this.pending.get(session.meta.id)?.messages.map((m) => m.id) ?? []);
    const run = this.flushChain.then(() => this.rewritePending(session, messages, staleIds));
    this.flushChain = run.catch(() => undefined);
    await run;
  }

  /** rewrite 主体（串行链上执行） */
  private async rewritePending(session: Session, messages: Message[], staleIds: Set<string>): Promise<void> {
    await this.ensureDir();
    const file = this.messageFile(session.meta.id);
    const tmp = `${file}.tmp`;
    // 先写临时文件再原子改名：中断时旧文件仍完整，不会损坏会话（POSIX 600：会话内容属用户隐私）
    await writeFile(tmp, messages.map((m) => JSON.stringify(m)).join("\n") + "\n", { mode: 0o600, encoding: "utf8" });
    await rename(tmp, file);
    session.replaceAll(messages);
    session.meta.updatedAt = new Date().toISOString();
    // 汇总的消息数跟重写后的历史收缩；usage 是累计值保持不变（增量账随下次 flush 并入）
    if (session.meta.summary) {
      session.meta.summary.messageCount = messages.length;
    }
    await writeFile(this.metaFile(session.meta.id), JSON.stringify(session.meta, null, 2), { mode: 0o600, encoding: "utf8" });
    // 删除快照中的旧消息（否则后续 flush 会把旧消息追加到重写后的 JSONL 造成错位）；
    // 重写期间新 append 的消息保留。删除在全部 IO 之后：重写失败则 pending 原样保留，flush 仍可补盘
    const entry = this.pending.get(session.meta.id);
    if (entry) {
      const remaining = entry.messages.filter((m) => !staleIds.has(m.id));
      if (remaining.length === 0) this.pending.delete(session.meta.id);
      else entry.messages = remaining;
    }
  }

  /**
   * 写会话结束标记：flush 后在 meta.summary 记 endedAt/endedReason。
   * 主会话在宿主收尾调用（exit/switch/reconfigure），子 agent 由终态回调调用。
   * 从未落盘的草稿会话（无 meta 文件）跳过，不为空会话补建文件；
   * 幂等可重复调用（后续终态覆盖前值，计数以 flush 时的为准）。
   * @param session 目标会话
   * @param reason 结束原因
   * @param opts.onlyIfUnended 已有结束标记时不再覆盖（会话级兜底收尾用：
   *   真终态回调已写过标记，兜底不把「已完成」错改成「中断」）
   */
  async finalizeSession(
    session: Session,
    reason: string,
    opts: { onlyIfUnended?: boolean } = {},
  ): Promise<void> {
    const id = session.meta.id;
    const run = this.flushChain.then(async () => {
      // meta 文件不存在 = 从未落盘的草稿会话：跳过不建文件
      try {
        await stat(this.metaFile(id));
      } catch {
        return;
      }
      if (opts.onlyIfUnended && session.meta.summary?.endedAt) return;
      await this.flushPending();
      const summary = session.meta.summary ?? { messageCount: session.getMessages().length, usage: {} };
      summary.endedAt = new Date().toISOString();
      summary.endedReason = reason;
      session.meta.summary = summary;
      await writeFile(this.metaFile(id), JSON.stringify(session.meta, null, 2), { mode: 0o600, encoding: "utf8" });
    });
    this.flushChain = run.catch(() => undefined);
    await run;
  }

  /**
   * 列出全部主会话元数据（附每会话消息文件大小，/session 面板副行展示用）。
   * 子 agent 会话（meta.kind 为 subagent）不进列表：它们随主会话管理，单独列出只会干扰选择。
   * @returns 会话列表项数组，按更新时间倒序
   */
  async listSessions(): Promise<SessionListItem[]> {
    const metas = await this.readMetas();
    const items: SessionListItem[] = [];
    for (const meta of metas) {
      if (meta.kind === "subagent") continue;
      let sizeBytes = 0;
      try {
        sizeBytes = (await stat(this.messageFile(meta.id))).size;
      } catch {
        // 消息文件缺失（异常会话）：大小按 0 计，列表仍正常展示
      }
      items.push({ ...meta, sizeBytes });
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 读取目录下全部可解析的会话 meta（损坏/形状不全的跳过；目录不存在返回空） */
  private async readMetas(): Promise<SessionMeta[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      // 目录不存在（从未建过会话）返回空列表；其余错误（EACCES 等）上抛——
      // 一律吞成「无会话」会让权限问题伪装成空状态，用户误以为会话全丢
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const metas: SessionMeta[] = [];
    for (const file of files) {
      if (!file.endsWith(".meta.json")) continue;
      const id = file.slice(0, -".meta.json".length);
      try {
        const raw = await readFile(path.join(this.dir, file), "utf8");
        const meta = JSON.parse(raw) as SessionMeta;
        // 形状不完整（JSON 合法但缺关键字段，如手改少删了字段）：列表排序依赖 updatedAt，
        // 缺了会在排序时 TypeError 拖垮整个列表，同样跳过
        if (!meta.id || !meta.updatedAt) continue;
        metas.push(meta);
      } catch {
        // 单个会话 meta 损坏（手改/写盘中断）：跳过该条不拖垮整体——
        // 与消息坏行跳过的处理一致（宁丢一条不拖垮整体）；坏 meta 的会话仍可直接删文件清理
      }
    }
    return metas;
  }

  /**
   * 删除会话：移除消息 JSONL 与元数据文件，并清理该会话的待落盘攒批；
   * 其名下全部子 agent 会话一并级联删除（子会话 meta 的 parentSessionId 指向主会话 id）。
   * 走串行链执行：在途 flush 完成后再删文件，防落盘把已删文件重建成本清单永不展示的孤儿。
   * 持久化删除不可逆，调用方负责确认目标（/session 面板一步删除只作用于非当前会话）。
   * @param id 会话 id
   */
  async deleteSession(id: string): Promise<void> {
    const run = this.flushChain.then(() => this.deleteNow(id));
    this.flushChain = run.catch(() => undefined);
    await run;
  }

  /** delete 主体（串行链上执行） */
  private async deleteNow(id: string): Promise<void> {
    this.pending.delete(id); // 丢弃该会话未 flush 的攒批消息，不留残留
    this.usageDelta.delete(id);
    this.stopReasons.delete(id);
    await this.ensureDir();
    await rm(this.messageFile(id), { force: true });
    await rm(this.metaFile(id), { force: true });
    // 级联删除子会话（孙会话的 parentSessionId 同样指主会话 id，一次扫描全部覆盖）
    const metas = await this.readMetas();
    for (const meta of metas) {
      if (meta.kind === "subagent" && meta.parentSessionId === id) {
        this.pending.delete(meta.id);
        this.usageDelta.delete(meta.id);
        this.stopReasons.delete(meta.id);
        await rm(this.messageFile(meta.id), { force: true });
        await rm(this.metaFile(meta.id), { force: true });
      }
    }
  }
}

/**
 * 用量累加：各分项分别求和，双方都缺的分项不落键。
 * @param a 累计值（可缺省，首次记账前无累计）
 * @param b 增量（可缺省，本批无 assistant 消息）
 * @returns 累加结果
 */
function addUsage(a: ModelUsage | undefined, b: ModelUsage | undefined): ModelUsage {
  const sum: ModelUsage = {};
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "promptTokens"] as const) {
    const total = (a?.[key] ?? 0) + (b?.[key] ?? 0);
    if (total > 0) sum[key] = total;
  }
  return sum;
}
