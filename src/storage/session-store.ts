import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Message } from "../core/index.js";
import { appendJsonlBatch, readJsonl } from "./jsonl.js";
import { Session, type SessionMeta } from "./session.js";

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
   * 列出全部会话元数据。
   * @returns 会话元数据数组，按更新时间倒序
   */
  async listSessions(): Promise<SessionMeta[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const file of files) {
      if (file.endsWith(".meta.json")) {
        const raw = await readFile(path.join(this.dir, file), "utf8");
        metas.push(JSON.parse(raw) as SessionMeta);
      }
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
