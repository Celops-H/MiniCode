/**
 * 统一排队泵（E109）：在途操作期间入队的消息与命令同存一个按入队顺序排列的待办队列，
 * 消费时永远取队首、按类型路由——排队条展示顺序即实际执行顺序。此前消息与命令分两条
 * 传输队列各自 FIFO，跨队列不保序（先入队的消息可能被后入队的命令抢先执行）。
 */
import type { QueuedItem } from "./state.js";

/** 输入泵一次轮询的决策：取走消息交给输入源跑轮次 / 取走命令交给命令处理 / 等待下次唤醒 */
export type QueuePumpDecision =
  | { op: "message"; text: string }
  | { op: "command"; text: string }
  | { op: "wait" };

/** 泵决策的两扇门（调用方按当前状态组合，见 loop 的 inputSource）：
 *  - messageWait：消息暂停取用——压缩执行中（防新发消息的轮次与压缩的历史重写并发）、
 *    /init 提示词装弹中（防消息插队到装弹生成的提示词之前）、弹窗打开中（防在弹窗后面
 *    隐身跑轮次）；
 *  - commandWait：命令暂停取用——任一在途（回合运行中/子 agent/压缩/装弹，防 handleCommand
 *    把出队命令重新入队翻转顺序）、弹窗打开中（防后入队命令关掉先入队命令刚打开的弹窗）。 */
export interface PumpQueueCtx {
  messageWait: boolean;
  commandWait: boolean;
}

/**
 * 队首消费决策（纯函数）：队列空或对应类型的门未放行一律等待；消息与命令都只看队首，
 * 队首不动则整队等待——这是跨类型保序的关键。
 */
export function pumpQueue(head: QueuedItem | undefined, ctx: PumpQueueCtx): QueuePumpDecision {
  if (!head) return { op: "wait" };
  if (head.kind === "message") {
    return ctx.messageWait ? { op: "wait" } : { op: "message", text: head.text };
  }
  return ctx.commandWait ? { op: "wait" } : { op: "command", text: head.text };
}

/** 队列中末个同类型同文本项的下标（Ctrl+P 取消用：展示队列弹末项，传输队列同步移除同项） */
export function lastIndexOfItem(
  queue: ReadonlyArray<QueuedItem>,
  item: Pick<QueuedItem, "kind" | "text">,
): number {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.kind === item.kind && queue[i]!.text === item.text) return i;
  }
  return -1;
}
