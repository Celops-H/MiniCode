import type { Message } from "../core/index.js";

/** 会话元数据：独立于消息存储，用于会话列表与索引 */
export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** 消息格式版本号：加载旧会话缺失时视为 1（历史格式兼容） */
  formatVersion: number;
}

/** 会话列表项：元数据 + 消息文件大小（运行时补充，不落盘；/session 面板副行展示用） */
export interface SessionListItem extends SessionMeta {
  /** 消息 JSONL 文件大小（字节）；文件缺失为 0 */
  sizeBytes: number;
}

/** 会话：元数据 + 内存消息列表（JSONL 是持久化副本，此处为运行时镜像） */
export class Session {
  readonly meta: SessionMeta;
  private readonly messages: Message[];

  constructor(meta: SessionMeta, messages: Message[] = []) {
    this.meta = meta;
    this.messages = messages;
  }

  /**
   * 获取会话全部消息。
   * @returns 消息数组的副本
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * 追加一条消息到内存列表。
   * @param message 待追加的消息
   */
  append(message: Message): void {
    this.messages.push(message);
  }

  /**
   * 整体替换内存消息（压缩重写后调用，与磁盘重写配套）。
   * @param messages 新消息数组
   */
  replaceAll(messages: Message[]): void {
    this.messages.length = 0;
    this.messages.push(...messages);
  }
}
