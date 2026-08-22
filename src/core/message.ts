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

/** 工具结果：toolCallId 配对键 + toolName 来源工具 + isError 成败标记 */
export interface ToolResultMessage {
  role: "tool_result";
  toolCallId: string;
  /** 来源工具名，溯源/渲染无需反查 assistant 的工具调用 */
  toolName: string;
  isError: boolean;
  content: string;
  timestamp: string;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/**
 * 构造用户消息。
 * @param content 用户输入内容
 * @returns 用户消息
 */
export function userMessage(content: string): UserMessage {
  return { role: "user", content };
}

/**
 * 构造模型回复。
 * @param content 内容块数组（文本 / 思考 / 工具调用）
 * @param meta 调用元数据（模型、用量、停因等），可选
 * @returns 模型回复消息
 */
export function assistantMessage(content: ContentBlock[], meta?: AssistantMeta): AssistantMessage {
  return { role: "assistant", content, ...(meta ? { meta } : {}) };
}

/**
 * 构造工具结果消息。
 * @param toolCallId 对应的工具调用 id（配对键）
 * @param toolName 来源工具名
 * @param content 工具输出文本
 * @param isError 是否执行失败，默认 false
 * @param timestamp 时间戳，默认当前时间
 * @returns 工具结果消息
 */
export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: string,
  isError = false,
  timestamp = new Date().toISOString(),
): ToolResultMessage {
  return { role: "tool_result", toolCallId, toolName, isError, content, timestamp };
}

/**
 * 从 AssistantMessage 提取工具调用数组。
 * @param message 模型回复消息
 * @returns 工具调用数组（仅 tool_call 内容块）
 */
export function toolCallsOf(message: AssistantMessage): ToolCall[] {
  return message.content.filter((b): b is ToolCall => b.type === "tool_call");
}
