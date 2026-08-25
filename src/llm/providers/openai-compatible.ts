import OpenAI from "openai";
import { resolveAuth } from "../auth.js";
import { OpenAICompletionsProtocol } from "../protocol/index.js";
import type { Context, StreamEvent } from "../../core/index.js";
import type { Provider, ProviderAuth, ModelInfo } from "../types.js";

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
    this.protocol = new OpenAICompletionsProtocol({ reasoningContent: options.reasoningContent });
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
    try {
      const stream = await this.getClient().chat.completions.create(
        {
          ...(request as Record<string, unknown>),
          model: modelId,
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

/** 流空闲超时（ms）：厂商断流/网络中断、N 秒无新 chunk 时中断并报错（SDK timeout 不覆盖流式响应体读取） */
export const STREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * 默认用官方 OpenAI SDK 创建 client（带请求超时，防厂商请求挂起无限等待）。
 * @param apiKey API key
 * @param baseUrl 厂商 API 地址
 * @returns OpenAI 兼容 client
 */
export function defaultCreateClient(apiKey: string, baseUrl: string): ChatCompletionsClient {
  return new OpenAI({ baseURL: baseUrl, apiKey, timeout: REQUEST_TIMEOUT_MS }) as unknown as ChatCompletionsClient;
}

/**
 * 流空闲超时包装：底层流 N 秒无产出（厂商 SSE 静默挂起、网络中断但连接不关）时，
 * 触发 onIdle 中断底层请求并抛「模型响应超时」错误——SDK 的 timeout 只覆盖响应头，
 * 读流式 body 无超时，这里补上，防正常运行期无限挂起（真机「卡住不返回」根因）。
 * 中断不碰用户 signal：用户打断语义（interrupt）由调用方处理，二者不互相污染。
 * @param source 底层事件流（parseStream 的产出）
 * @param idleMs 空闲超时（无新 chunk 的容忍窗口）
 * @param onIdle 超时触发的中断回调（abort 底层请求，让挂起的读取尽快释放）
 * @returns 包装后的流
 */
async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  onIdle: () => void,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  let timer: NodeJS.Timeout | undefined;
  try {
    while (true) {
      const next = iterator.next();
      // 防 unhandled rejection：onIdle 中断底层后，挂起的 next 可能 reject（本处不 await 它）
      next.catch(() => undefined);
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onIdle();
          reject(new Error(`模型响应超时：${idleMs / 1000} 秒未收到新数据（厂商断流或网络中断）`));
        }, idleMs);
      });
      const result = await Promise.race([next, deadline]);
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (result.done) return;
      yield result.value;
    }
  } finally {
    if (timer) clearTimeout(timer);
    timer = undefined;
    // 不等待 return：永挂流（await 永不 settle）的 return() 也永不完成，等待会把收尾卡死；
    // 触发清理但不等结果，底层流正常时自会释放
    iterator.return?.().catch(() => undefined);
  }
}
