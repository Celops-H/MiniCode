import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Message } from "../core/index.js";
import { appendJsonl, readJsonl } from "./jsonl.js";
import { Session, type SessionMeta } from "./session.js";

/**
 * 会话存储：消息以 JSONL 一行一条落盘（唯一数据源），元数据独立成文件便于索引。
 * 目录约定：<id>.jsonl（消息）、<id>.meta.json（元数据）。
 * meta 延迟写：appendMessage 只更新内存，flush() 统一落盘，避免每条消息重写 meta 文件。
 */
export class SessionStore {
  private readonly dir: string;
  /** 内存 meta 已变更、待 flush 落盘的会话 */
  private readonly dirty = new Set<Session>();

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
   * 追加一条消息到会话文件与内存，并刷新会话更新时间。
   * 消息 JSONL 立即追加（append-only 无写放大）；meta 延迟写，flush() 统一落盘。
   * @param session 目标会话
   * @param message 待追加的消息
   */
  async appendMessage(session: Session, message: Message): Promise<void> {
    session.append(message);
    session.meta.updatedAt = new Date().toISOString();
    await this.ensureDir();
    await appendJsonl(this.messageFile(session.meta.id), message);
    // 只标记 dirty，不重写 meta 文件；flush() 时统一写盘（修复每条消息重写 meta 的写放大）
    this.dirty.add(session);
  }

  /**
   * 强制落盘：把内存中已变更的会话元数据（updatedAt 等）写入 meta 文件。
   * 交互关键节点调用，保证崩溃时元数据不丢、列表排序准确。
   */
  async flush(): Promise<void> {
    if (this.dirty.size === 0) return;
    await this.ensureDir();
    for (const session of this.dirty) {
      await writeFile(this.metaFile(session.meta.id), JSON.stringify(session.meta, null, 2), "utf8");
    }
    this.dirty.clear();
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
