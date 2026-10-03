/**
 * agent 邮箱：每 agent 一个消息队列。
 * MESSAGE 排队不唤醒（send_message）；NEW_TASK / FINAL_ANSWER 投递 + 唤醒
 * （triggerTurn=true，followup_task / spawn 初始任务 / watcher 结论回灌）；
 * INTERRUPTED 只排队不唤醒（子 agent 中断标记），且不参与续跑判定——
 * 收件箱只剩它时被打断的 agent 保持终态退出，标记留给下次输入消费。
 * 收件箱消息在 turn 组装上下文时被消费注入；调度器唤醒判定看 hasPending。
 */
import type { AgentPath } from "./agent-path.js";

/** 消息类型：普通消息 / 初始任务 / 完成结论 / 中断标记 */
export type MailType = "MESSAGE" | "NEW_TASK" | "FINAL_ANSWER" | "INTERRUPTED";

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

/** 把消息格式化为注入模型的文本（消息即上下文，模型直接读文本） */
export function formatMailMessage(mail: MailMessage): string {
  const header =
    mail.type === "MESSAGE"
      ? "消息"
      : mail.type === "NEW_TASK"
        ? "新任务"
        : mail.type === "INTERRUPTED"
          ? "中断"
          : "任务结论";
  return `【${header}】from ${mail.from}:\n${mail.content}`;
}
