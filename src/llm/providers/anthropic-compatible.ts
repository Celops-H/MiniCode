import Anthropic from "@anthropic-ai/sdk";
import { resolveAuth } from "../auth.js";
import { AnthropicMessagesProtocol } from "../protocol/index.js";
import { REQUEST_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, withIdleTimeout } from "./timeout.js";
import type { Context, StreamEvent } from "../../core/index.js";
import type { Provider, ProviderAuth, ModelInfo } from "../types.js";

/** Anthropic 兼容 client 接口（默认官方 SDK，测试可注入 mock） */
export interface AnthropicMessagesClient {
  messages: {
    create(request: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AsyncIterable<unknown>>;
  };
}

export interface AnthropicCompatibleOptions {
  id: string;
  name: string;
  baseUrl: string;
  /** 存放 API key 的环境变量名 */
  apiKeyEnv: string;
  models: ModelInfo[];
  env?: NodeJS.ProcessEnv;
  /** 流空闲超时（ms）：厂商断流/网络中断、N 秒无新 chunk 时中断并报错；默认 STREAM_IDLE_TIMEOUT_MS */
  streamIdleTimeoutMs?: number;
  /** Anthropic 请求默认 max_tokens（请求体必填，模型未定义时兜底） */
  defaultMaxTokens?: number;
  /** 创建 client 的工厂（测试注入 mock） */
  createClient?: (apiKey: string, baseUrl: string) => AnthropicMessagesClient;
}

/**
 * Anthropic 兼容厂商 Provider（anthropic-messages 协议）：@anthropic-ai/sdk 客户端换
 * baseURL 复用，认证头 x-api-key + anthropic-version 由 SDK 负责。与
 * OpenAICompatibleProvider 同构：同一份纯数据配置、同一套流空闲超时与用户 signal
 * 转发逻辑，只有请求体/流式解析随协议走（AnthropicMessagesProtocol）。
 */
export class AnthropicCompatibleProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly auth: ProviderAuth;

  private readonly protocol: AnthropicMessagesProtocol;
  private readonly modelList: ModelInfo[];
  private readonly createClient: (apiKey: string, baseUrl: string) => AnthropicMessagesClient;
  private readonly streamIdleTimeoutMs: number;
  private readonly defaultMaxTokens: number;
  private readonly apiKey?: string;
  private client?: AnthropicMessagesClient;

  constructor(options: AnthropicCompatibleOptions) {
    this.id = options.id;
    this.name = options.name;
    this.baseUrl = options.baseUrl;
    this.modelList = options.models;
    this.protocol = new AnthropicMessagesProtocol();
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
    this.defaultMaxTokens = options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    const resolved = resolveAuth({ apiKeyEnv: options.apiKeyEnv, env: options.env });
    this.auth = resolved.auth;
    this.apiKey = resolved.apiKey;
    this.createClient = options.createClient ?? defaultAnthropicCreateClient;
  }

  /**
   * 返回该 Provider 声明的模型列表。
   * @returns 模型信息数组
   */
  getModels(): ModelInfo[] {
    return this.modelList;
  }

  /**
   * 流式调用模型：组装请求 → 发到 Anthropic 兼容 API → 转成统一事件流。
   * @param modelId 模型 id
   * @param context 一次模型调用的完整输入
   * @returns 统一事件流
   */
  async *stream(
    modelId: string,
    context: Context,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<StreamEvent> {
    // max_tokens 是 Anthropic 请求体必填项：取模型定义值，模型未定义时兜底
    const info = this.modelList.find((m) => m.id === modelId);
    const maxTokens = info?.maxTokens ?? this.defaultMaxTokens;
    // 跨厂商同 id 模型限定名（模型id@厂商id）：厂商侧请求用原始模型 id（BACKEND §5）
    const vendorModelId = info?.vendorId ?? modelId;
    const request = this.protocol.buildRequest(context);
    // 中断合并 controller 同 openai-compatible：用户 signal 转发 + idle 超时 abort 共用
    const controller = new AbortController();
    const userSignal = options?.signal;
    const forwardAbort = (): void => controller.abort();
    if (userSignal) {
      if (userSignal.aborted) controller.abort();
      else userSignal.addEventListener("abort", forwardAbort, { once: true });
    }
    try {
      const stream = await this.getClient().messages.create(
        {
          ...(request as Record<string, unknown>),
          model: vendorModelId,
          max_tokens: maxTokens,
          stream: true,
        },
        { signal: controller.signal },
      );
      yield* withIdleTimeout(this.protocol.parseStream(stream), this.streamIdleTimeoutMs, () =>
        controller.abort(),
      );
    } finally {
      if (userSignal) userSignal.removeEventListener("abort", forwardAbort);
    }
  }

  /** 惰性创建 client：首次调用时才实例化，未配置认证直接报错 */
  private getClient(): AnthropicMessagesClient {
    if (!this.apiKey) {
      throw new Error(`Provider ${this.id} 未配置认证：请设置环境变量`);
    }
    this.client ??= this.createClient(this.apiKey, this.baseUrl);
    return this.client;
  }
}

/** Anthropic 请求 max_tokens 兜底：模型未定义 contextWindow/maxTokens 时的输出上限 */
export const DEFAULT_MAX_TOKENS = 8192;

/**
 * 默认用官方 Anthropic SDK 创建 client（x-api-key + anthropic-version 认证头由 SDK
 * 注入；带请求超时，防厂商请求挂起无限等待）。
 * @param apiKey API key
 * @param baseUrl 厂商 API 地址（Anthropic 兼容端点）
 * @returns Anthropic 兼容 client
 */
export function defaultAnthropicCreateClient(apiKey: string, baseUrl: string): AnthropicMessagesClient {
  return new Anthropic({
    baseURL: baseUrl,
    apiKey,
    timeout: REQUEST_TIMEOUT_MS,
  }) as unknown as AnthropicMessagesClient;
}
