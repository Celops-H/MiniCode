import type { Message, ModelUsage } from "../core/index.js";
import type { ModelFallbackReason } from "../core/events.js";

/** Hook 事件类型（DESIGN 13.1 核心事件 + A 组子 agent 生命周期事件 + 可观测性扩容 5 事件，OBSERVABILITY §4.3） */
export const HOOK_EVENT_TYPES = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "AgentSpawned",
  "AgentCompleted",
  "AgentInterrupted",
  "MessageAppended",
  "LlmCallEnd",
  "PermissionDecision",
  "Compact",
  "ModelFallback",
] as const;
export type HookEventType = (typeof HOOK_EVENT_TYPES)[number];

/**
 * Hook 事件负载：携带事件发生时的现场信息（哪个工具、什么输入等）；
 * PreToolUse 用于拦截裁决，其余用于观测。
 * 工具事件带 toolCallId（工具回合配对键，DESIGN 7.2）——「调用中 → 成功/失败」可按调用配对，
 * 并发批内可区分；带 agentPath（发起调用的 agent，多 Agent 下可按路径归属「谁在干活」，此前确认）。
 * 子 agent 事件（此前确认）带 agent 路径（DESIGN 11 线程树），TUI/观测可按路径归属活动。
 */
export type HookEvent =
  | { type: "UserPromptSubmit"; input: string }
  | {
      type: "PreToolUse";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      agentPath: string;
    }
  | {
      type: "PostToolUse";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      output: string;
      isError: boolean;
      /** 工具执行耗时 ms（可观测性 B1 补充）：从工具真正开始执行到结果返回；
       *  执行前被拒绝/中断的调用没有执行窗口，不带该字段 */
      durationMs?: number;
      agentPath: string;
    }
  | {
      type: "PostToolUseFailure";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      error: string;
      /** 工具执行耗时 ms（可观测性 B1 补充）：执行中失败的调用带执行窗口耗时；
       *  执行前被拒绝（权限/参数校验/未知工具）没有执行窗口，不带该字段 */
      durationMs?: number;
      agentPath: string;
    }
  | { type: "Stop"; agentPath: string }
  | { type: "SessionStart" }
  | { type: "SessionEnd" }
  | { type: "AgentSpawned"; path: string; parentPath: string }
  /** failed 标记子 agent 失败终态（E81）：模型流失败等由驱动层捕获，结论不可信——
   *  失败不合并 worktree、conclusion 为明确失败文本 */
  | { type: "AgentCompleted"; path: string; parentPath: string; conclusion: string; mergeResult?: string; failed?: boolean }
  | { type: "AgentInterrupted"; path: string; parentPath: string }
  /**
   * 消息追加（可观测性 B1）：任何消息进入 agent 上下文时发（常规轮次产出、中断收尾
   * 合成的工具结果与错误消息、收件箱/系统注入、命令消息），message 为完整消息对象。
   * 子 agent 消息经此获得唯一落盘处（此前完全不落盘）；压缩重灌的在途消息不重发
   * （压缩前已发过，轨迹只追加不重复）。注意：订阅方会收到大 payload（完整工具结果）。
   */
  | { type: "MessageAppended"; message: Message; agentPath: string }
  /**
   * LLM 调用结束（可观测性 B1）：runTurn 流结束时发，失败/中断的调用也发；
   * 一次轮内的多次 API 尝试（超窗剥组重试、模型链切换）各自独立发一条。
   * systemPrompt.hash 每次必带，全文仅首次出现或变更时附带（content）。
   */
  | {
      type: "LlmCallEnd";
      agentPath: string;
      model: string;
      provider?: string;
      durationMs: number;
      /** 首事件延迟 ms（区分网络慢与生成慢）；未收到任何事件即结束（如冷却跳过后无调用）不带 */
      firstEventMs?: number;
      usage?: ModelUsage;
      stopReason?: string;
      systemPrompt?: { hash: string; content?: string };
      error?: string;
    }
  /**
   * 权限决策（可观测性 B1）：权限解析汇合后发（规则/hook/用户三分支）。
   * source 归并口径：hook=钩子裁决；user=用户审批与会话缓存（用户「允许会话全部」的记忆）；
   * rule=规则层与危险命令/模式等硬性判定。
   */
  | {
      type: "PermissionDecision";
      agentPath: string;
      toolCallId: string;
      toolName: string;
      decision: "allow" | "deny";
      source: "hook" | "rule" | "user";
    }
  /** 压缩动作（可观测性 B1）：doCompact 执行后发（成功与失败都发）；trigger 区分撞线自动与用户 /compact */
  | {
      type: "Compact";
      agentPath: string;
      trigger: "auto" | "manual";
      tokensBefore: number;
      tokensAfter: number;
      messagesBefore: number;
      messagesAfter: number;
      durationMs: number;
      ok: boolean;
      error?: string;
    }
  /** 模型切换（可观测性 B1）：agent 消费 model_fallback StreamEvent 处转发，reason 同源 */
  | { type: "ModelFallback"; agentPath: string; from: string; to: string; reason: ModelFallbackReason };

/** PreToolUse 拦截结果：deny 拒绝 / allow 放行 / ask 询问；多个 hook 同时返回时，deny 优先于 ask，ask 优先于 allow */
export type HookVerdict = "allow" | "deny" | "ask";

/** 从事件类型提取对应的事件负载（类型工具，供 on 注册时推断） */
export type HookEventOf<T extends HookEventType> = Extract<HookEvent, { type: T }>;

/** Hook 处理器函数：PreToolUse 返回拦截结果，其余事件只观察，返回 void */
export type HookHandler<T extends HookEvent> = (
  event: T,
) => HookVerdict | void | Promise<HookVerdict | void>;