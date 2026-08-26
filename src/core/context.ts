import type { Message } from "./message.js";

/** 思考等级（reasoning effort）：低/中/高；缺省由厂商默认，仅支持 reasoning_effort 的厂商生效 */
export type ThinkingLevel = "low" | "medium" | "high";

/** 工具定义：Context 携带给模型，工具系统在此基础上扩展 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** 工具参数 JSON Schema */
  inputSchema: Record<string, unknown>;
}

/** 一次模型调用的完整输入 */
export interface Context {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  /** 思考等级（可选）：模型调用时透传 reasoning_effort（仅声明支持的厂商） */
  thinkingLevel?: ThinkingLevel;
}

/**
 * 构造一次模型调用的完整输入（Context）。
 * @param systemPrompt 系统提示词，告诉模型「你是谁、干什么」
 * @param messages 对话历史，从早到晚排列
 * @param tools 可用工具清单，序列化为模型可见定义
 * @param thinkingLevel 思考等级（可选，透传请求参数）
 * @returns Context 对象
 */
export function createContext(
  systemPrompt: string,
  messages: Message[] = [],
  tools: ToolDefinition[] = [],
  thinkingLevel?: ThinkingLevel,
): Context {
  return { systemPrompt, messages, tools, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

/**
 * 追加消息，返回新 Context（不修改原对象，不可变更新）。
 * @param context 原 Context
 * @param message 待追加的消息
 * @returns 追加后的新 Context
 */
export function appendMessage(context: Context, message: Message): Context {
  return { ...context, messages: [...context.messages, message] };
}
