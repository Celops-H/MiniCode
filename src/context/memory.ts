import {
  assembleAssistantMessage,
  createContext,
  userMessage,
  type Context,
  type Message,
  type StreamEvent,
} from "../core/index.js";

/** 会话记忆（DESIGN 9.7）：平时持续维护的关键信息条目，压缩时替代现场摘要省模型调用 */
export const MEMORY_SYSTEM_PROMPT =
  "你是会话记忆维护器。根据最新对话增量更新记忆：保留目标、约束、进展、决策、文件路径、待办，" +
  "删除已被推翻或过时的内容。只输出更新后的完整记忆文本，不要客套，不要重复输出原文。";

/** 记忆更新请求的消息内容前缀（测试与调试用特征标记） */
export const MEMORY_REQUEST_MARKER = "请把最近对话增量合入会话记忆";

/** 记忆请求里单条消息的最大字符数（工具结果可能巨大，截断控制调用体积） */
const MAX_MESSAGE_CHARS = 2000;

/** 记忆单次更新的请求上下文：当前记忆 + 最近对话（截断控制调用体积） */
export interface MemoryUpdateRequest {
  /** 当前记忆（可为空串：首次建立） */
  currentMemory: string;
  /** 最近对话消息（供增量提取） */
  recentMessages: Message[];
  /** 参与更新的最近消息条数上限，默认 8 */
  maxRecentMessages?: number;
}

/**
 * 构建记忆更新请求的消息数组：请求指令 + 当前记忆 + 最近对话。
 * 单条消息内容截断到 MAX_MESSAGE_CHARS（工具结果可能巨大，防调用体积失控）。
 * @param options 请求参数
 * @returns 消息数组（供模型调用）
 */
export function buildMemoryUpdateRequest(options: MemoryUpdateRequest): Message[] {
  const { currentMemory, recentMessages, maxRecentMessages = 8 } = options;
  const recent = recentMessages.slice(-maxRecentMessages);
  const formatMessage = (m: Message): string => {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `${m.role}: ${text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text}`;
  };
  const prompt =
    `${MEMORY_REQUEST_MARKER}。\n` +
    `当前记忆：\n${currentMemory || "（空，首次建立）"}\n` +
    `最近对话：\n${recent.map(formatMessage).join("\n")}`;
  return [userMessage(prompt)];
}

/**
 * 用模型增量更新会话记忆：请求 = 当前记忆 + 最近对话，模型返回更新后的完整记忆文本。
 * @param client 模型流（Summarizer）
 * @param modelId 模型 id
 * @param options 请求参数
 * @returns 更新后的记忆文本（可能为空串：模型未返回文本）
 */
export async function updateMemory(
  client: { stream(modelId: string, context: Context): AsyncIterable<StreamEvent> },
  modelId: string,
  options: MemoryUpdateRequest,
): Promise<string> {
  const context = createContext(MEMORY_SYSTEM_PROMPT, buildMemoryUpdateRequest(options), []);
  const assistant = await assembleAssistantMessage(client.stream(modelId, context));
  return assistant.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}