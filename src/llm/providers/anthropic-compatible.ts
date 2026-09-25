import Anthropic from "@anthropic-ai/sdk";
import { resolveAuth } from "../auth.js";
import { AnthropicMessagesProtocol } from "../protocol/index.js";
import { REQUEST_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, TAIL_GRACE_TIMEOUT_MS, withIdleTimeout } from "./timeout.js";
import type { Context, StreamEvent, ThinkingLevel } from "../../core/index.js";
import type { Provider, ProviderAuth, ModelInfo } from "../types.js";

/** Anthropic 兼容 client 接口（默认官方 SDK，测试可注入 mock） */
export interface AnthropicMessagesClient {
  messages: {
    create(request: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AsyncIterable<unknown>>;
  };
}

/** Anthropic 兼容 client 工厂：headers 为 provider 配置的附加请求头（E64，经 SDK defaultHeaders 透传） */
export type AnthropicMessagesClientFactory = (
  apiKey: string,
  baseUrl: string,
  headers?: Record<string, string>,
) => AnthropicMessagesClient;

export interface AnthropicCompatibleOptions {
  id: string;
  name: string;
  baseUrl: string;
  /** 存放 API key 的环境变量名 */
  apiKeyEnv: string;
  /** 落盘 API key（配置 provider.apiKey，E33：与环境变量同权、env 优先） */
  apiKey?: string;
  models: ModelInfo[];
  env?: NodeJS.ProcessEnv;
  /** 附加请求头，经 SDK defaultHeaders 透传（anthropic-beta 等场景，E64） */
  headers?: Record<string, string>;
  /** 流空闲超时（ms）：厂商断流/网络中断、N 秒无新 chunk 时中断并报错；默认 STREAM_IDLE_TIMEOUT_MS */
  streamIdleTimeoutMs?: number;
  /** 收尾宽限窗（ms，E47）：stop_reason/message_stop 已到后空闲按正常收尾关流不报超时；默认 TAIL_GRACE_TIMEOUT_MS */
  streamTailGraceMs?: number;
  /** Anthropic 请求默认 max_tokens（请求体必填，模型未定义时兜底） */
  defaultMaxTokens?: number;
  /** 创建 client 的工厂（测试注入 mock） */
  createClient?: AnthropicMessagesClientFactory;
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
  private readonly createClient: AnthropicMessagesClientFactory;
  private readonly streamIdleTimeoutMs: number;
  private readonly streamTailGraceMs: number;
  private readonly defaultMaxTokens: number;
  private readonly apiKeyEnv: string;
  private readonly apiKey?: string;
  private readonly headers?: Record<string, string>;
  private client?: AnthropicMessagesClient;

  constructor(options: AnthropicCompatibleOptions) {
    this.id = options.id;
    this.name = options.name;
    this.baseUrl = options.baseUrl;
    this.modelList = options.models;
    this.protocol = new AnthropicMessagesProtocol();
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
    this.streamTailGraceMs = options.streamTailGraceMs ?? TAIL_GRACE_TIMEOUT_MS;
    this.defaultMaxTokens = options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.apiKeyEnv = options.apiKeyEnv;
    const resolved = resolveAuth({ apiKeyEnv: options.apiKeyEnv, storedKey: options.apiKey, env: options.env });
    this.auth = resolved.auth;
    this.apiKey = resolved.apiKey;
    this.headers = options.headers;
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
    // 思考等级（E17）：anthropic 协议以 thinking 预算表达；maxTokens 决定预算上限
    const thinking = context.thinkingLevel
      ? anthropicThinkingParam(context.thinkingLevel, maxTokens)
      : undefined;
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
          // 未设等级或 maxTokens 承载不了思考时为 undefined：不带该字段，退回厂商默认
          ...(thinking ? { thinking } : {}),
          stream: true,
        },
        { signal: controller.signal },
      );
      // 空闲超时包在原始流外：anthropic 的 ping 等不产出事件的 chunk 也算活跃，
      // 长思考静默期不被误判超时；超时异常经协议层补发 error 事件后原样抛出。
      // 收尾宽限（E47）：stop_reason / message_stop 已到即响应完整，个别厂商握着连接
      // 不发结束帧，宽限窗后正常关流（协议以 stop_reason 收 done），不再误报超时丢整轮
      yield* this.protocol.parseStream(
        withIdleTimeout(stream, this.streamIdleTimeoutMs, () => controller.abort(), {
          isTailChunk: anthropicEventFinished,
          tailGraceMs: this.streamTailGraceMs,
        }),
      );
    } finally {
      if (userSignal) userSignal.removeEventListener("abort", forwardAbort);
    }
  }

  /** 惰性创建 client：首次调用时才实例化，未配置认证直接报错 */
  private getClient(): AnthropicMessagesClient {
    if (!this.apiKey) {
      // E59：文案带上具体环境变量名，用户可直接定位要配的变量
      throw new Error(`Provider ${this.id} 未配置认证：请设置环境变量 ${this.apiKeyEnv}`);
    }
    this.client ??= this.createClient(this.apiKey, this.baseUrl, this.headers);
    return this.client;
  }
}

/** Anthropic 请求 max_tokens 兜底：模型未定义 contextWindow/maxTokens 时的输出上限 */
export const DEFAULT_MAX_TOKENS = 8192;

/**
 * 响应完成事件判定（E47 收尾宽限）：message_delta 带 stop_reason 即响应逻辑完成
 * （Anthropic 的停止原因在 message_delta，message_stop 是紧随的结束帧）。
 * @param event 一个流式响应事件
 * @returns 是否为完成信号
 */
function anthropicEventFinished(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const e = event as { type?: unknown; delta?: { stop_reason?: unknown } };
  if (e.type === "message_stop") return true;
  return e.type === "message_delta" && Boolean(e.delta?.stop_reason);
}

/** 思考等级 → thinking 预算（budget_tokens）的基础映射（E17） */
const THINKING_BUDGETS: Record<ThinkingLevel, number> = { low: 2048, medium: 4096, high: 8192 };

/**
 * 思考等级 → Anthropic 请求体 thinking 参数。
 * Anthropic 规定 budget_tokens ≥1024 且 < max_tokens：按 maxTokens 钳制（留 1024
 * 输出头寸）；maxTokens < 2048 时承载不了思考（cap = maxTokens - 1024 不足下限），
 * 返回 undefined（不发，退回厂商默认）；恰为 2048 时预算压到下限 1024。
 * @param level 思考等级
 * @param maxTokens 请求 max_tokens（模型定义值或缺省兜底）
 * @returns thinking 参数；等级无法承载时 undefined
 */
export function anthropicThinkingParam(
  level: ThinkingLevel,
  maxTokens: number,
): { type: "enabled"; budget_tokens: number } | undefined {
  const cap = maxTokens - 1024;
  if (cap < 1024) return undefined;
  return { type: "enabled", budget_tokens: Math.min(THINKING_BUDGETS[level], cap) };
}

/**
 * 默认用官方 Anthropic SDK 创建 client（x-api-key + anthropic-version 认证头由 SDK
 * 注入；带请求超时，防厂商请求挂起无限等待）。
 * maxRetries 显式为 0（E58）：SDK 默认对 429/5xx/网络错误静默重试两次，与 ModelRouter
 * 的冷却/切换叠加会把失败转移拖到最坏约 75s 之后——失败转移由路由层独占。
 * @param apiKey API key
 * @param baseUrl 厂商 API 地址（Anthropic 兼容端点）
 * @param headers 附加请求头（provider 配置 headers，经 defaultHeaders 随每个请求透传，E64）
 * @returns Anthropic 兼容 client
 */
export function defaultAnthropicCreateClient(
  apiKey: string,
  baseUrl: string,
  headers?: Record<string, string>,
): AnthropicMessagesClient {
  return new Anthropic({
    baseURL: baseUrl,
    apiKey,
    ...(headers && Object.keys(headers).length > 0 ? { defaultHeaders: headers } : {}),
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  }) as unknown as AnthropicMessagesClient;
}
