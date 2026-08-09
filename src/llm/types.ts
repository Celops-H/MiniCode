import type { Context, StreamEvent } from "../core/index.js";

/** 协议标识：按协议分，不按厂商分 */
export type ProtocolType =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses"
  | "gemini";

/** 认证状态 */
export interface ProviderAuth {
  configured: boolean;
  source?: "env" | "stored" | "oauth";
}

/** 模型定义（纯数据、可序列化） */
export interface ModelInfo {
  id: string;
  name: string;
  api: ProtocolType;
  providerId: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** 协议：统一格式 ↔ 厂商格式双向转换 */
export interface Protocol {
  readonly type: ProtocolType;
  /** 统一 Context → 厂商请求体（含消息、工具 schema 转换） */
  buildRequest(context: Context): unknown;
  /** 厂商流式响应 → 统一事件流 */
  parseStream(stream: AsyncIterable<unknown>): AsyncIterable<StreamEvent>;
}

/** 运行时单元：认证、模型列表、流式调用 */
export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly auth: ProviderAuth;
  getModels(): ModelInfo[];
  stream(modelId: string, context: Context): AsyncIterable<StreamEvent>;
}
