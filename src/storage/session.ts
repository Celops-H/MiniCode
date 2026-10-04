import type { Message, ModelUsage } from "../core/index.js";

/**
 * 会话级汇总：随 meta 落盘（flush 时刷新），面板与统计取用量不必扫消息文件。
 * usage 跨压缩累计（压缩只换历史不抹掉已花的 token），messageCount 跟随当前消息数。
 */
export interface SessionSummary {
  /** 当前消息数（压缩重写后随之收缩） */
  messageCount: number;
  /** 累计模型用量：各分项按次累加 */
  usage: ModelUsage;
  /** 最后一次模型回复的停因（失败轮为 error: 前缀口径，与 assistant.meta.stopReason 同源） */
  lastStopReason?: string;
  /**
   * 会话结束标记：写的是「最后一次收尾」的时间与原因，不是「当前已停止」——
   * 已标记的会话再续跑（复活子 agent、切换后重进同一会话）期间标记保留原值，
   * 由下一次收尾覆盖；异常退出无新标记，读到的是此前最后一次收尾。
   */
  endedAt?: string;
  /** 结束原因：主会话 exit/switch/reconfigure；子 agent completed/failed/interrupted */
  endedReason?: string;
}

/** 新会话默认标题：所有创建点共用；自动起名以「标题仍是默认值」判定未起过名 */
export const DEFAULT_SESSION_TITLE = "新会话";

/** 自动起名的标题长度上限（按码点截，emoji 代理对不切成乱码） */
const TITLE_MAX_CODEPOINTS = 30;

/**
 * 从用户输入派生会话标题（首轮结束后自动起名用）：
 * 连续空白（含换行）压成单空格，超长按码点截断补省略号。
 * @param input 用户输入原文
 * @returns 派生的标题
 */
export function sessionTitleFromInput(input: string): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  const codepoints = Array.from(collapsed);
  if (codepoints.length <= TITLE_MAX_CODEPOINTS) return collapsed;
  return `${codepoints.slice(0, TITLE_MAX_CODEPOINTS).join("")}…`;
}

/** 会话元数据：独立于消息存储，用于会话列表与索引 */
export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** 消息格式版本号：加载旧会话缺失时视为 1（历史格式兼容） */
  formatVersion: number;
  /** 会话类别：缺省主会话；subagent 为子 agent 会话（列表隐藏，随主会话级联删除） */
  kind?: "subagent";
  /** 子 agent 会话所属的主会话 id（kind 为 subagent 时存在） */
  parentSessionId?: string;
  /** 子 agent 在团队中的路径（kind 为 subagent 时存在，如 /root/task_1） */
  agentPath?: string;
  /** 会话级汇总（flush 时刷新） */
  summary?: SessionSummary;
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
