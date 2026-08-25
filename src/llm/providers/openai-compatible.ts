import OpenAI from "openai";
import { resolveAuth } from "../auth.js";
import { OpenAICompletionsProtocol } from "../protocol/index.js";
import type { Context, StreamEvent } from "../../core/index.js";
import type { Provider, ProviderAuth, ModelInfo } from "../types.js";

/** OpenAI 兼容 client 接口（默认官方 SDK，测试可注入 mock） */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(request: Record<string, unknown>): Promise<AsyncIterable<unknown>>;
    };
  };
}

export interface OpenAICompatibleOptions {
  id: string;
  name: string;
  baseUrl: string;
  /** 存放 API key 的环境变量名 */
  apiKeyEnv: string;
  models: ModelInfo[];
  env?: NodeJS.ProcessEnv;
  /** DeepSeek 等推理厂商：assistant 的 thinking 回传为 reasoning_content 字段（工具调用后必须，否则 400） */
  reasoningContent?: boolean;
  /** 创建 client 的工厂（测试注入 mock） */
  createClient?: (apiKey: string, baseUrl: string) => ChatCompletionsClient;
}

/** OpenAI 兼容厂商 Provider：复用 openai-chat-completions 协议，只改 baseUrl */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly auth: ProviderAuth;

  private readonly protocol: OpenAICompletionsProtocol;
  private readonly modelList: ModelInfo[];
  private readonly createClient: (apiKey: string, baseUrl: string) => ChatCompletionsClient;
  private readonly apiKey?: string;
  private client?: ChatCompletionsClient;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.name = options.name;
    this.baseUrl = options.baseUrl;
    this.modelList = options.models;
    this.protocol = new OpenAICompletionsProtocol({ reasoningContent: options.reasoningContent });
    const resolved = resolveAuth({ apiKeyEnv: options.apiKeyEnv, env: options.env });
    this.auth = resolved.auth;
    this.apiKey = resolved.apiKey;
    this.createClient = options.createClient ?? defaultCreateClient;
  }

  /**
   * 返回该 Provider 声明的模型列表。
   * @returns 模型信息数组
   */
  getModels(): ModelInfo[] {
    return this.modelList;
  }

  /**
   * 流式调用模型：组装请求 → 发到 OpenAI 兼容 API → 转成统一事件流。
   * @param modelId 模型 id
   * @param context 一次模型调用的完整输入
   * @returns 统一事件流
   */
  async *stream(
    modelId: string,
    context: Context,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<StreamEvent> {
    const request = this.protocol.buildRequest(context);
    const stream = await this.getClient().chat.completions.create({
      ...(request as Record<string, unknown>),
      model: modelId,
      stream: true,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    yield* this.protocol.parseStream(stream);
  }

  /** 惰性创建 client：首次调用时才实例化，未配置认证直接报错 */
  private getClient(): ChatCompletionsClient {
    if (!this.apiKey) {
      throw new Error(`Provider ${this.id} 未配置认证：请设置环境变量`);
    }
    this.client ??= this.createClient(this.apiKey, this.baseUrl);
    return this.client;
  }
}

/** 模型请求超时（ms）：厂商慢/挂起时不再无限等待——超时抛错走路由切换或错误渲染 */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * 默认用官方 OpenAI SDK 创建 client（带请求超时，防厂商请求挂起无限等待）。
 * @param apiKey API key
 * @param baseUrl 厂商 API 地址
 * @returns OpenAI 兼容 client
 */
export function defaultCreateClient(apiKey: string, baseUrl: string): ChatCompletionsClient {
  return new OpenAI({ baseURL: baseUrl, apiKey, timeout: REQUEST_TIMEOUT_MS }) as unknown as ChatCompletionsClient;
}
