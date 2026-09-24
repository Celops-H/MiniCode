import OpenAI from "openai";
import { resolveAuth } from "../auth.js";
import { OpenAICompletionsProtocol } from "../protocol/index.js";
import { REQUEST_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, TAIL_GRACE_TIMEOUT_MS, withIdleTimeout } from "./timeout.js";
import type { Context, StreamEvent } from "../../core/index.js";
import type { Provider, ProviderAuth, ModelInfo } from "../types.js";

// 常量自共享模块取（anthropic-compatible 同用）；此处 re-export 维持原导出路径
export { REQUEST_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, TAIL_GRACE_TIMEOUT_MS };

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
  /** 落盘 API key（配置 provider.apiKey，E33：与环境变量同权、env 优先） */
  apiKey?: string;
  models: ModelInfo[];
  env?: NodeJS.ProcessEnv;
  /** DeepSeek 等推理厂商：assistant 的 thinking 回传为 reasoning_content 字段（工具调用后必须，否则 400） */
  reasoningContent?: boolean;
  /** 支持 reasoning_effort 请求参数的厂商（仅 OpenAI 系；其余厂商发该字段可能 400，不 emit） */
  reasoningEffort?: boolean;
  /** 流空闲超时（ms）：厂商断流/网络中断、N 秒无新 chunk 时中断并报错；默认 STREAM_IDLE_TIMEOUT_MS */
  streamIdleTimeoutMs?: number;
  /** 收尾宽限窗（ms，E47）：finish_reason 已到后空闲按正常收尾关流不报超时；默认 TAIL_GRACE_TIMEOUT_MS */
  streamTailGraceMs?: number;
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
  private readonly streamTailGraceMs: number;
  private readonly apiKeyEnv: string;
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
    this.streamTailGraceMs = options.streamTailGraceMs ?? TAIL_GRACE_TIMEOUT_MS;
    this.apiKeyEnv = options.apiKeyEnv;
    const resolved = resolveAuth({ apiKeyEnv: options.apiKeyEnv, storedKey: options.apiKey, env: options.env });
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
      // 长思考静默期不被误判超时；超时异常经协议层补发 error 事件后原样抛出。
      // 收尾宽限（E47）：finish_reason 已到即响应完整，个别厂商握着连接不发 [DONE]，
      // 宽限窗后正常关流（协议以 finish_reason 收 done），不再误报超时丢整轮
      yield* this.protocol.parseStream(
        withIdleTimeout(stream, this.streamIdleTimeoutMs, () => controller.abort(), {
          isTailChunk: openaiChunkFinished,
          tailGraceMs: this.streamTailGraceMs,
        }),
      );
    } finally {
      if (userSignal) userSignal.removeEventListener("abort", forwardAbort);
    }
  }

  /** 惰性创建 client：首次调用时才实例化，未配置认证直接报错 */
  private getClient(): ChatCompletionsClient {
    if (!this.apiKey) {
      // E59：文案带上具体环境变量名，用户可直接定位要配的变量
      throw new Error(`Provider ${this.id} 未配置认证：请设置环境变量 ${this.apiKeyEnv}`);
    }
    this.client ??= this.createClient(this.apiKey, this.baseUrl);
    return this.client;
  }
}

/**
 * finish_reason 判定（E47 收尾宽限）：首个 choice 带停止原因即响应逻辑完成
 * （与协议 parseStream 的 firstChoice 同口径，只认第一个 choice）。
 * @param chunk 一个流式响应片段
 * @returns 是否携带 finish_reason
 */
function openaiChunkFinished(chunk: unknown): boolean {
  if (typeof chunk !== "object" || chunk === null) return false;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) return false;
  return Boolean((choice as { finish_reason?: unknown }).finish_reason);
}

/**
 * 默认用官方 OpenAI SDK 创建 client（带请求超时，防厂商请求挂起无限等待）。
 * maxRetries 显式为 0（E58）：SDK 默认对 429/5xx/网络错误静默重试两次，与 ModelRouter
 * 的冷却/切换叠加会把失败转移拖到最坏约 75s 之后——失败转移由路由层独占。
 * @param apiKey API key
 * @param baseUrl 厂商 API 地址
 * @returns OpenAI 兼容 client
 */
export function defaultCreateClient(apiKey: string, baseUrl: string): ChatCompletionsClient {
  return new OpenAI({
    baseURL: baseUrl,
    apiKey,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  }) as unknown as ChatCompletionsClient;
}
