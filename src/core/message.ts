/**
 * 统一消息模型：全项目通用数据格式，所有厂商差异在此屏蔽。
 * 三种消息 + 内容块（Text / Thinking / ToolCall）。
 */

import { randomUUID } from "node:crypto";

export type ContentBlock = TextContent | ThinkingContent | ToolCall;

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** 思考块签名（anthropic 流下发）：同模型回传时随块携带，厂商侧校验思考真实性 */
  signature?: string;
  /** 加密思考数据（anthropic redacted_thinking 块）：无明文思考，同模型回传时原样携带 */
  redactedData?: string;
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
  /**
   * 缓存读命中 token：anthropic 取 cache_read_input_tokens；
   * openai 取 prompt_tokens_details.cached_tokens（cached ⊆ prompt_tokens）
   */
  cacheReadTokens?: number;
  /** 缓存写入 token：anthropic 取 cache_creation_input_tokens；openai 无写缓存概念不携带 */
  cacheWriteTokens?: number;
  /**
   * 本次请求占用的上下文全量（prompt 侧 token 总数，含系统提示词与工具定义）。
   * 协议归一：openai 即 prompt_tokens（厂商口径已含缓存段）；
   * anthropic 为 input_tokens + cache_read + cache_creation（厂商各字段互不相含，
   * 相加才是请求真实占用的窗口量）。水位显示与压缩触发按它回填真实值。
   */
  promptTokens?: number;
}

/** AssistantMessage 的调用元数据（供观测 / 续跑） */
export interface AssistantMeta {
  api?: string;
  provider?: string;
  model?: string;
  usage?: ModelUsage;
  stopReason?: string;
}

/** 消息来源：human 真实用户输入；system 系统注入（摘要/恢复上下文等合成消息）；command 用户命令痕迹（/init /compact 等命令消息） */
export type MessageSource = "human" | "system" | "command";

/** 命令消息的文本前缀（持久化与重演时识别命令痕迹） */
export const COMMAND_MARKER = "【命令】";

/** 用户输入 */
export interface UserMessage {
  role: "user";
  /** 稳定 id：压缩裁剪旧消息、会话重放、排查定位时精确指认消息 */
  id: string;
  content: string;
  /** 消息来源，缺省 human；系统注入的合成消息标 "system"，让模型区分背景信息与用户指令；命令痕迹标 "command" */
  source?: MessageSource;
  /** 消息创建时间（ISO）：会话恢复时展示用；旧数据可能缺失 */
  timestamp?: string;
}

/** 模型回复：内容块数组 + 调用元数据 */
export interface AssistantMessage {
  role: "assistant";
  /** 稳定 id：压缩裁剪旧消息、会话重放、排查定位时精确指认消息 */
  id: string;
  content: ContentBlock[];
  meta?: AssistantMeta;
  /** 消息创建时间（ISO）：会话恢复时展示用；旧数据可能缺失 */
  timestamp?: string;
}

/** 工具结果：toolCallId 配对键 + toolName 来源工具 + isError 成败标记 */
export interface ToolResultMessage {
  role: "tool_result";
  /** 稳定 id：压缩裁剪旧消息、会话重放、排查定位时精确指认消息 */
  id: string;
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
 * @param source 消息来源，系统注入的合成消息标 "system"，缺省 human
 * @param id 稳定 id，缺省随机生成
 * @param timestamp 消息创建时间，缺省当前时间（会话恢复展示用）
 * @returns 用户消息
 */
export function userMessage(
  content: string,
  source?: MessageSource,
  id: string = randomUUID(),
  timestamp = new Date().toISOString(),
): UserMessage {
  return { role: "user", id, content, ...(source ? { source } : {}), timestamp };
}

/**
 * 构造模型回复。
 * @param content 内容块数组（文本 / 思考 / 工具调用）
 * @param meta 调用元数据（模型、用量、停因等），可选
 * @param id 稳定 id，缺省随机生成
 * @param timestamp 消息创建时间，缺省当前时间（会话恢复展示用）
 * @returns 模型回复消息
 */
export function assistantMessage(
  content: ContentBlock[],
  meta?: AssistantMeta,
  id: string = randomUUID(),
  timestamp = new Date().toISOString(),
): AssistantMessage {
  return { role: "assistant", id, content, ...(meta ? { meta } : {}), timestamp };
}

/**
 * 构造工具结果消息。
 * @param toolCallId 对应的工具调用 id（配对键）
 * @param toolName 来源工具名
 * @param content 工具输出文本
 * @param isError 是否执行失败，默认 false
 * @param timestamp 时间戳，默认当前时间
 * @param id 稳定 id，缺省随机生成
 * @returns 工具结果消息
 */
export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: string,
  isError = false,
  timestamp = new Date().toISOString(),
  id: string = randomUUID(),
): ToolResultMessage {
  return { role: "tool_result", id, toolCallId, toolName, isError, content, timestamp };
}

/**
 * 从 AssistantMessage 提取工具调用数组。
 * @param message 模型回复消息
 * @returns 工具调用数组（仅 tool_call 内容块）
 */
export function toolCallsOf(message: AssistantMessage): ToolCall[] {
  return message.content.filter((b): b is ToolCall => b.type === "tool_call");
}
