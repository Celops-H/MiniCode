import type { Message } from "../core/index.js";

/** 会话元数据：独立于消息存储，用于会话列表与索引 */
export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

/** 会话：元数据 + 内存消息列表（JSONL 是持久化副本，此处为运行时镜像） */
export class Session {
  readonly meta: SessionMeta;
  private readonly messages: Message[];

  constructor(meta: SessionMeta, messages: Message[] = []) {
    this.meta = meta;
    this.messages = messages;
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  append(message: Message): void {
    this.messages.push(message);
  }
}
