/**
 * 统一排队泵：消费决策矩阵与跨类型保序。
 * 此前消息与命令分两条传输队列各自 FIFO，跨队列不保序——排队条顺序与实际执行顺序不一致；
 * 改为单一待办队列后，泵永远取队首、按类型路由，本文件用泵决策序列锁定该语义。
 * 两扇门（messageWait/commandWait）锁定三个等待窗口：压缩执行中防消息轮次与历史重写并发、
 * /init 装弹窗口防消息插队、弹窗打开中防在弹窗后面隐身消费。
 */
import { describe, expect, it } from "vitest";
import { lastIndexOfItem, pumpQueue, type PumpQueueCtx } from "../../src/tui/queue.js";
import type { QueuedItem } from "../../src/tui/state.js";

const msg = (text: string): QueuedItem => ({ id: `m_${text}`, kind: "message", text });
const cmd = (text: string): QueuedItem => ({ id: `c_${text}`, kind: "command", text });

/** 空闲放行态：无压缩、无装弹、无弹窗、无在途 */
const IDLE: PumpQueueCtx = { messageWait: false, commandWait: false };

describe("pumpQueue 消费决策", () => {
  it("空队列：等待", () => {
    expect(pumpQueue(undefined, IDLE)).toEqual({ op: "wait" });
  });

  it("队首消息：空闲即取走跑轮次（子 agent 后台运行不挡消息，轮次并发由 interact 侧守卫承担）", () => {
    expect(pumpQueue(msg("问题"), IDLE)).toEqual({ op: "message", text: "问题" });
  });

  it("队首消息 + 压缩执行中：等待（防轮次与压缩的历史重写并发）", () => {
    expect(pumpQueue(msg("问题"), { messageWait: true, commandWait: true })).toEqual({ op: "wait" });
  });

  it("队首消息 + /init 装弹中：等待（防消息插队到装弹生成的提示词之前）", () => {
    expect(pumpQueue(msg("问题"), { messageWait: true, commandWait: true })).toEqual({ op: "wait" });
  });

  it("队首消息 + 弹窗打开中：等待（防在弹窗后面隐身跑轮次）", () => {
    expect(pumpQueue(msg("问题"), { messageWait: true, commandWait: true })).toEqual({ op: "wait" });
  });

  it("队首命令：在途未结束等待（防 handleCommand 重新入队翻转顺序），结束取走执行", () => {
    expect(pumpQueue(cmd("/clear"), { messageWait: false, commandWait: true })).toEqual({ op: "wait" });
    expect(pumpQueue(cmd("/clear"), IDLE)).toEqual({ op: "command", text: "/clear" });
  });

  it("队首命令 + 弹窗打开中：等待（防后入队命令关掉先入队命令刚打开的弹窗）", () => {
    expect(pumpQueue(cmd("/clear"), { messageWait: true, commandWait: true })).toEqual({ op: "wait" });
  });
});

describe("消费顺序 = 入队顺序（跨类型保序）", () => {
  /** 模拟门放行后的逐项消费：每次按泵决策取走队首，记录执行序列 */
  function drainAll(queue: QueuedItem[], ctx: PumpQueueCtx): string[] {
    const rest = [...queue];
    const executed: string[] = [];
    for (;;) {
      const decision = pumpQueue(rest[0], ctx);
      if (decision.op === "wait") break;
      rest.shift();
      executed.push(`${decision.op}:${decision.text}`);
    }
    return executed;
  }

  it("消息在前命令在后：消息轮次先跑，命令随后执行", () => {
    expect(drainAll([msg("问题"), cmd("/clear")], IDLE)).toEqual(["message:问题", "command:/clear"]);
  });

  it("命令在前消息在后：命令先执行，消息轮次随后", () => {
    expect(drainAll([cmd("/clear"), msg("问题")], IDLE)).toEqual(["command:/clear", "message:问题"]);
  });

  it("同类型连发保持 FIFO", () => {
    expect(drainAll([msg("一"), msg("二")], IDLE)).toEqual(["message:一", "message:二"]);
    expect(drainAll([cmd("/clear"), cmd("/help")], IDLE)).toEqual(["command:/clear", "command:/help"]);
  });

  it("在途未结束时命令挡住队首，整队等待收尾唤醒后再按序消费", () => {
    const queue = [cmd("/clear"), msg("问题")];
    const gated: PumpQueueCtx = { messageWait: false, commandWait: true };
    expect(pumpQueue(queue[0], gated)).toEqual({ op: "wait" });
    expect(drainAll(queue, gated)).toEqual([]);
    // 收尾唤醒（门放行）后同一队列按序消费
    expect(drainAll(queue, IDLE)).toEqual(["command:/clear", "message:问题"]);
  });

  it("压缩执行中新发的消息不击穿命令后的等待：门放行前消息与命令都不消费", () => {
    // 泵取走排队 /compact 后等压缩收尾；此窗口用户新发的消息进队，门不放行
    const queue = [msg("压缩期间新发的消息")];
    const compacting: PumpQueueCtx = { messageWait: true, commandWait: true };
    expect(drainAll(queue, compacting)).toEqual([]);
    // 压缩收尾（compacting 复位 + 唤醒）后消息继续跑轮次
    expect(drainAll(queue, IDLE)).toEqual(["message:压缩期间新发的消息"]);
  });

  it("/init 装弹窗口：先入队的消息不插队到装弹生成的提示词之前", () => {
    // 队首 /init：空闲 → 取走执行，随即进入装弹窗口
    const queue: QueuedItem[] = [cmd("/init")];
    expect(pumpQueue(queue[0], IDLE)).toEqual({ op: "command", text: "/init" });
    queue.shift();
    // 装弹期间用户入队一条消息：装弹未完成，消息等待
    queue.push(msg("普通消息"));
    const preparing: PumpQueueCtx = { messageWait: true, commandWait: true };
    expect(pumpQueue(queue[0], preparing)).toEqual({ op: "wait" });
    // 装弹完成：生成的提示词插回队首（loop 侧行为），先于普通消息消费
    queue.unshift(msg("【/init】生成的提示词"));
    expect(pumpQueue(queue[0], IDLE)).toEqual({ op: "message", text: "【/init】生成的提示词" });
    queue.shift();
    expect(pumpQueue(queue[0], IDLE)).toEqual({ op: "message", text: "普通消息" });
  });
});

describe("lastIndexOfItem（取消恢复的传输侧匹配）", () => {
  it("同类型同文本多条目取末条", () => {
    const queue = [msg("重复"), msg("其他"), msg("重复")];
    expect(lastIndexOfItem(queue, { kind: "message", text: "重复" })).toBe(2);
  });

  it("类型不同不匹配：同文本的消息与命令互不误配", () => {
    const queue = [msg("/clear"), cmd("/clear")];
    expect(lastIndexOfItem(queue, { kind: "command", text: "/clear" })).toBe(1);
    expect(lastIndexOfItem(queue, { kind: "message", text: "/clear" })).toBe(0);
  });

  it("目标项已被取走返回 -1（取消的毫秒级窗口：展示队列尚存、传输队列已取走）", () => {
    const queue = [msg("还在")];
    expect(lastIndexOfItem(queue, { kind: "message", text: "已被取走" })).toBe(-1);
    expect(lastIndexOfItem([], { kind: "message", text: "任意" })).toBe(-1);
  });
});
