/** Hook 事件类型（DESIGN 13.1 核心事件 + A 组子 agent 生命周期事件） */
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
      agentPath: string;
    }
  | {
      type: "PostToolUseFailure";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      error: string;
      agentPath: string;
    }
  | { type: "Stop"; agentPath: string }
  | { type: "SessionStart" }
  | { type: "SessionEnd" }
  | { type: "AgentSpawned"; path: string; parentPath: string }
  | { type: "AgentCompleted"; path: string; parentPath: string; conclusion: string; mergeResult?: string }
  | { type: "AgentInterrupted"; path: string; parentPath: string };

/** PreToolUse 拦截结果：deny 拒绝 / allow 放行 / ask 询问；多个 hook 同时返回时，deny 优先于 ask，ask 优先于 allow */
export type HookVerdict = "allow" | "deny" | "ask";

/** 从事件类型提取对应的事件负载（类型工具，供 on 注册时推断） */
export type HookEventOf<T extends HookEventType> = Extract<HookEvent, { type: T }>;

/** Hook 处理器函数：PreToolUse 返回拦截结果，其余事件只观察，返回 void */
export type HookHandler<T extends HookEvent> = (
  event: T,
) => HookVerdict | void | Promise<HookVerdict | void>;