/** Hook 事件类型（DESIGN 13.1 核心事件；子代理事件待 M3.2 接入） */
export type HookEventType =
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop"
  | "SessionStart"
  | "SessionEnd";

/** Hook 事件负载：携带事件发生时的现场信息（哪个工具、什么输入等）；PreToolUse 用于拦截裁决，其余用于观测 */
export type HookEvent =
  | { type: "UserPromptSubmit"; input: string }
  | { type: "PreToolUse"; toolName: string; input: Record<string, unknown> }
  | {
      type: "PostToolUse";
      toolName: string;
      input: Record<string, unknown>;
      output: string;
      isError: boolean;
    }
  | {
      type: "PostToolUseFailure";
      toolName: string;
      input: Record<string, unknown>;
      error: string;
    }
  | { type: "Stop" }
  | { type: "SessionStart" }
  | { type: "SessionEnd" };

/** PreToolUse 拦截结果：deny 拒绝 / allow 放行 / ask 询问；多个 hook 同时返回时，deny 优先于 ask，ask 优先于 allow */
export type HookVerdict = "allow" | "deny" | "ask";

/** 从事件类型提取对应的事件负载（类型工具，供 on 注册时推断） */
export type HookEventOf<T extends HookEventType> = Extract<HookEvent, { type: T }>;

/** Hook 处理器函数：PreToolUse 返回拦截结果，其余事件只观察，返回 void */
export type HookHandler<T extends HookEvent> = (
  event: T,
) => HookVerdict | void | Promise<HookVerdict | void>;