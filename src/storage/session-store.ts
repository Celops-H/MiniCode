import { readFile, writeFile, readdir, mkdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Message } from "../core/index.js";
import { appendJsonlBatch, readJsonl } from "./jsonl.js";
import { Session, type SessionMeta, type SessionListItem } from "./session.js";

/**
 * 会话存储：消息以 JSONL 一行一条落盘（唯一数据源），元数据独立成文件便于索引。
 * 目录约定：<id>.jsonl（消息）、<id>.meta.json（元数据）。
 * write-behind 攒批：appendMessage 只更新内存，flush() 统一批量落盘，
 * 避免每条消息逐次 I/O 与重写 meta 文件的写放大。
 */
export class SessionStore {
  private readonly dir: string;
  /** 待 flush 落盘的消息（按会话攒批） */
  private readonly pending = new Map<string, { session: Session; messages: Message[] }>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private messageFile(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  private metaFile(id: string): string {
    return path.join(this.dir, `${id}.meta.json`);
  }

  /** 确保存储目录存在（写操作前调用）。 */
  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
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
      title: options.title ?? "新会话",
      model: options.model,
      createdAt: now,
      updatedAt: now,
      formatVersion: 1,
    };
    await this.ensureDir();
    await writeFile(this.metaFile(meta.id), JSON.stringify(meta, null, 2), "utf8");
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
    // 旧会话无 formatVersion 字段，视为版本 1
    const meta: SessionMeta = { ...parsed, formatVersion: parsed.formatVersion ?? 1 };
    const messages = await readJsonl<Message>(this.messageFile(id));
    return new Session(meta, messages);
  }

  /**
   * 追加一条消息到会话内存并记入攒批队列；flush() 时批量落盘。
   * @param session 目标会话
   * @param message 待追加的消息
   */
  async appendMessage(session: Session, message: Message): Promise<void> {
    session.append(message);
    session.meta.updatedAt = new Date().toISOString();
    const entry = this.pending.get(session.meta.id) ?? { session, messages: [] };
    entry.messages.push(message);
    this.pending.set(session.meta.id, entry);
  }

  /**
   * 强制落盘：把攒批的消息一次 append 写 JSONL，并写回已变更的会话元数据。
   * 交互关键节点调用（DESIGN 14 flush 屏障），保证崩溃时已完成回合的消息不丢。
   */
  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    await this.ensureDir();
    // 逐个会话：消息落盘成功后立即从 pending 移除（幂等），
    // 即使后续 meta 写失败，重试 flush 也不会把已落盘消息重复追加到 JSONL
    for (const [id, { session, messages }] of [...this.pending]) {
      await appendJsonlBatch(this.messageFile(id), messages);
      this.pending.delete(id);
      await writeFile(this.metaFile(id), JSON.stringify(session.meta, null, 2), "utf8");
    }
  }

  /**
   * 重写会话整份消息（/compact 压缩替换后调用）：临时文件 + 原子改名替换 JSONL，
   * 保证单一数据源与内存一致；同时更新会话内存与元数据时间。
   * @param session 目标会话
   * @param messages 新消息数组（压缩后的完整消息）
   */
  async rewriteMessages(session: Session, messages: Message[]): Promise<void> {
    // 快照必须放在函数第一行（首个 await 前）：appendMessage 是同步的，
    // 若快照在 ensureDir 之后，调用 rewrite 后立即 append 的消息会被当成旧消息误删
    // （review 修复：并发 append 的新消息保留，重写前的旧消息稍后删除）
    const staleIds = new Set(this.pending.get(session.meta.id)?.messages.map((m) => m.id) ?? []);
    await this.ensureDir();
    const file = this.messageFile(session.meta.id);
    const tmp = `${file}.tmp`;
    // 先写临时文件再原子改名：中断时旧文件仍完整，不会损坏会话
    await writeFile(tmp, messages.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
    await rename(tmp, file);
    session.replaceAll(messages);
    session.meta.updatedAt = new Date().toISOString();
    await writeFile(this.metaFile(session.meta.id), JSON.stringify(session.meta, null, 2), "utf8");
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
   * 列出全部会话元数据（附每会话消息文件大小，/session 面板副行展示用）。
   * @returns 会话列表项数组，按更新时间倒序
   */
  async listSessions(): Promise<SessionListItem[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const items: SessionListItem[] = [];
    for (const file of files) {
      if (file.endsWith(".meta.json")) {
        const id = file.slice(0, -".meta.json".length);
        const raw = await readFile(path.join(this.dir, file), "utf8");
        const meta = JSON.parse(raw) as SessionMeta;
        let sizeBytes = 0;
        try {
          sizeBytes = (await stat(this.messageFile(id))).size;
        } catch {
          // 消息文件缺失（异常会话）：大小按 0 计，列表仍正常展示
        }
        items.push({ ...meta, sizeBytes });
      }
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * 删除会话：移除消息 JSONL 与元数据文件，并清理该会话的待落盘攒批。
   * 持久化删除不可逆，调用方负责确认目标（/session 面板一步删除只作用于非当前会话）。
   * @param id 会话 id
   */
  async deleteSession(id: string): Promise<void> {
    this.pending.delete(id); // 丢弃该会话未 flush 的攒批消息，不留残留
    await this.ensureDir();
    await rm(this.messageFile(id), { force: true });
    await rm(this.metaFile(id), { force: true });
  }
}
