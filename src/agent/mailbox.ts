/**
 * agent 邮箱：每 agent 一个消息队列。
 * MESSAGE 排队不唤醒（send_message）；NEW_TASK / FINAL_ANSWER / FAILED 投递 + 唤醒
 * （triggerTurn=true，followup_task / spawn 初始任务 / watcher 结论回灌，FAILED 为失败终态）；
 * INTERRUPTED 只排队不唤醒（子 agent 中断标记），且不参与续跑判定——
 * 收件箱只剩它时被打断的 agent 保持终态退出，标记留给下次输入消费。
 * 收件箱消息在 turn 组装上下文时被消费注入；调度器唤醒判定看 hasPending。
 */
import type { AgentPath } from "./agent-path.js";

/** 消息类型：普通消息 / 初始任务 / 完成结论 / 失败终态 / 中断标记 */
export type MailType = "MESSAGE" | "NEW_TASK" | "FINAL_ANSWER" | "FAILED" | "INTERRUPTED";

export interface MailMessage {
  type: MailType;
  /** 发送方 agent 路径 */
  from: AgentPath;
  content: string;
  /** 投递后唤醒目标 agent 续跑（followup_task / NEW_TASK / FINAL_ANSWER / FAILED） */
  triggerTurn: boolean;
}

/** 消息队列：入队、runnable 判定、排空（取走全部） */
export class Mailbox {
  private readonly items: MailMessage[] = [];

  enqueue(message: MailMessage): void {
    this.items.push(message);
  }

  /** 收件箱是否有未消费消息（调度器 runnable 判定） */
  hasPending(): boolean {
    return this.items.length > 0;
  }

  /**
   * 收件箱是否有参与续跑判定的消息（中断标记以外的全部类型）。
   * 续跑循环轮末据此决定继续跑还是保持终态：中断标记只传递状态，
   * 不构成「有新任务要处理」，不能顶着打断意图重启被打断的 agent。
   */
  hasReviving(): boolean {
    return this.items.some((message) => message.type !== "INTERRUPTED");
  }

  /** 取走全部未消费消息（注入上下文后清空） */
  drain(): MailMessage[] {
    return this.items.splice(0);
  }
}

/** 消息类型 → 头部标记：格式化、反解与头部正则同出这一份，三处永远一致 */
const MAIL_HEADERS: Array<[MailType, string]> = [
  ["MESSAGE", "消息"],
  ["NEW_TASK", "新任务"],
  ["INTERRUPTED", "中断"],
  ["FAILED", "任务失败"],
  ["FINAL_ANSWER", "任务结论"],
];

/** 注入消息全文的头部形态（正则由 MAIL_HEADERS 派生） */
const MAIL_TEXT_HEADER_RE = new RegExp(`^【(${MAIL_HEADERS.map(([, header]) => header).join("|")})】from .*:\\n?`);

/** 把消息格式化为注入模型的文本（消息即上下文，模型直接读文本）。
 *  失败终态用独立头部「任务失败」，成功结论与失败在文本层就不同形，
 *  恢复会话据此重建失败态，不再把失败当完成 */
export function formatMailMessage(mail: MailMessage): string {
  const header = MAIL_HEADERS.find(([type]) => type === mail.type)![1];
  return `【${header}】from ${mail.from}:\n${mail.content}`;
}

/**
 * 从格式化文本反解注入消息（会话恢复重演用）：头部认类型，正文取标记行之后。
 * 只认 formatMailMessage 的固定形态，不匹配返回 undefined（普通用户消息照常走消息渲染）。
 * @param text 注入消息的全文（UserMessage.content）
 * @returns 消息类型与正文，非注入消息格式返回 undefined
 */
export function parseMailText(text: string): { type: MailType; body: string } | undefined {
  const match = MAIL_TEXT_HEADER_RE.exec(text);
  if (!match) return undefined;
  // 捕获组来自 MAIL_HEADERS 派生的正则，命中必有对应类型
  const type = MAIL_HEADERS.find(([, header]) => header === match[1])![0];
  return { type, body: text.slice(match[0].length) };
}
