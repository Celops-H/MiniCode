/**
 * agent 邮箱（DESIGN 11.3）：每 agent 一个消息队列。
 * 双语义：MESSAGE 排队不唤醒（send_message）；NEW_TASK / FINAL_ANSWER 投递 + 唤醒
 * （triggerTurn=true，followup_task / spawn 初始任务 / watcher 结论回灌）。
 * 收件箱消息在 turn 组装上下文时被消费注入；唤醒判定看 hasTriggerTurn。
 */
import type { AgentPath } from "./agent-path.js";

/** 消息类型：普通消息 / 初始任务 / 完成结论 */
export type MailType = "MESSAGE" | "NEW_TASK" | "FINAL_ANSWER";

export interface MailMessage {
  type: MailType;
  /** 发送方 agent 路径 */
  from: AgentPath;
  content: string;
  /** 投递后唤醒目标 agent 续跑（followup_task / NEW_TASK / FINAL_ANSWER） */
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

  /** 是否有唤醒型消息（trigger_turn） */
  hasTriggerTurn(): boolean {
    return this.items.some((mail) => mail.triggerTurn);
  }

  /** 取走全部未消费消息（注入上下文后清空） */
  drain(): MailMessage[] {
    return this.items.splice(0);
  }
}

/** 把消息格式化为注入模型的文本（消息即上下文，模型直接读文本） */
export function formatMailMessage(mail: MailMessage): string {
  const header =
    mail.type === "MESSAGE" ? "消息" : mail.type === "NEW_TASK" ? "新任务" : "任务结论";
  return `【${header}】from ${mail.from}:\n${mail.content}`;
}