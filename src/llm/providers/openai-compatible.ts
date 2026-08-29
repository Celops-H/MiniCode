import OpenAI from "openai";
import { resolveAuth } from "../auth.js";
import { OpenAICompletionsProtocol } from "../protocol/index.js";
import { REQUEST_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, withIdleTimeout } from "./timeout.js";
import type { Context, StreamEvent } from "../../core/index.js";
import type { Provider, ProviderAuth, ModelInfo } from "../types.js";

// 常量自共享模块取（anthropic-compatible 同用）；此处 re-export 维持原导出路径
export { REQUEST_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS };

/** OpenAI 兼容 client 接口（默认官方 SDK，测试可注入 mock） */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(request: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AsyncIterable<unknown>>;
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
  /** 支持 reasoning_effort 请求参数的厂商（仅 OpenAI 系；其余厂商发该字段可能 400，不 emit） */
  reasoningEffort?: boolean;
  /** 流空闲超时（ms）：厂商断流/网络中断、N 秒无新 chunk 时中断并报错；默认 STREAM_IDLE_TIMEOUT_MS */
  streamIdleTimeoutMs?: number;
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
  private readonly streamIdleTimeoutMs: number;
  private readonly apiKey?: string;
  private client?: ChatCompletionsClient;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.name = options.name;
    this.baseUrl = options.baseUrl;
    this.modelList = options.models;
    this.protocol = new OpenAICompletionsProtocol({
      reasoningContent: options.reasoningContent,
      emitReasoningEffort: options.reasoningEffort,
    });
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
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
    // SDK 的 timeout 只覆盖响应头到达前，读流式响应体没有超时——厂商 SSE 中途静默挂起
    // （连接保持、不再推数据、也不关闭）会无限挂起（真机「卡住不返回」根因）。这里补一个
    // 流空闲超时：N 秒无新 chunk 主动中断底层请求并报错。
    // 中断用合并 controller 驱动：用户 signal 转发（保持打断语义，interrupt 真正中断模型请求）
    // + idle 超时 abort；传给 SDK 的是合并后的 signal，任一触发都会中断底层读取。
    const controller = new AbortController();
    const userSignal = options?.signal;
    const forwardAbort = (): void => controller.abort();
    if (userSignal) {
      if (userSignal.aborted) controller.abort();
      else userSignal.addEventListener("abort", forwardAbort, { once: true });
    }
    // 跨厂商同 id 模型限定名（模型id@厂商id）：厂商侧请求用原始模型 id（BACKEND §5）
    const vendorModelId = this.modelList.find((m) => m.id === modelId)?.vendorId ?? modelId;
    try {
      const stream = await this.getClient().chat.completions.create(
        {
          ...(request as Record<string, unknown>),
          model: vendorModelId,
          stream: true,
        },
        { signal: controller.signal },
      );
      // 空闲超时包在原始流外：厂商 ping、仅 role 的 chunk 等不产出事件的 chunk 也算活跃，
      // 长思考静默期不被误判超时；超时异常经协议层补发 error 事件后原样抛出
      yield* this.protocol.parseStream(
        withIdleTimeout(stream, this.streamIdleTimeoutMs, () => controller.abort()),
      );
    } finally {
      if (userSignal) userSignal.removeEventListener("abort", forwardAbort);
    }
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

/**
 * 默认用官方 OpenAI SDK 创建 client（带请求超时，防厂商请求挂起无限等待）。
 * @param apiKey API key
 * @param baseUrl 厂商 API 地址
 * @returns OpenAI 兼容 client
 */
export function defaultCreateClient(apiKey: string, baseUrl: string): ChatCompletionsClient {
  return new OpenAI({ baseURL: baseUrl, apiKey, timeout: REQUEST_TIMEOUT_MS }) as unknown as ChatCompletionsClient;
}
