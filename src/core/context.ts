import type { Message } from "./message.js";

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
}

export function createContext(
  systemPrompt: string,
  messages: Message[] = [],
  tools: ToolDefinition[] = [],
): Context {
  return { systemPrompt, messages, tools };
}

/** 追加消息，返回新 Context（不修改原对象） */
export function appendMessage(context: Context, message: Message): Context {
  return { ...context, messages: [...context.messages, message] };
}
