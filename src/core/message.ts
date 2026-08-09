/**
 * 统一消息模型：全项目通用数据格式，所有厂商差异在此屏蔽。
 * 三种消息 + 内容块（Text / Thinking / ToolCall）。
 */

export type ContentBlock = TextContent | ThinkingContent | ToolCall;

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCall {
  type: "tool_call";
  /** 工具调用 id，与 ToolResultMessage.toolCallId 配对 */
  id: string;
  name: string;
  /** 工具参数（JSON 对象） */
  input: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** AssistantMessage 的调用元数据（供观测 / 续跑） */
export interface AssistantMeta {
  api?: string;
  provider?: string;
  model?: string;
  usage?: ModelUsage;
  stopReason?: string;
}

/** 用户输入 */
export interface UserMessage {
  role: "user";
  content: string;
}

/** 模型回复：内容块数组 + 调用元数据 */
export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  meta?: AssistantMeta;
}

/** 工具结果：toolCallId 配对键 + isError 成败标记 */
export interface ToolResultMessage {
  role: "tool_result";
  toolCallId: string;
  isError: boolean;
  content: string;
  timestamp: string;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export function userMessage(content: string): UserMessage {
  return { role: "user", content };
}

export function assistantMessage(content: ContentBlock[], meta?: AssistantMeta): AssistantMessage {
  return { role: "assistant", content, ...(meta ? { meta } : {}) };
}

export function toolResultMessage(
  toolCallId: string,
  content: string,
  isError = false,
  timestamp = new Date().toISOString(),
): ToolResultMessage {
  return { role: "tool_result", toolCallId, isError, content, timestamp };
}

/** 从 AssistantMessage 提取工具调用数组（主循环使用） */
export function toolCallsOf(message: AssistantMessage): ToolCall[] {
  return message.content.filter((b): b is ToolCall => b.type === "tool_call");
}
