import OpenAI from "openai";
import { resolveAuth } from "../auth.js";
import { OpenAICompletionsProtocol } from "../protocol/index.js";
import type { Context, StreamEvent } from "../../core/index.js";
import type { Provider, ProviderAuth, ModelInfo } from "../types.js";

/** OpenAI 兼容 client 的最小形状（默认官方 SDK，测试可注入 mock） */
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
  /** 创建 client 的工厂（测试注入 mock） */
  createClient?: (apiKey: string, baseUrl: string) => ChatCompletionsClient;
}

/** OpenAI 兼容厂商 Provider：复用 openai-chat-completions 协议，只改 baseUrl */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly auth: ProviderAuth;

  private readonly protocol = new OpenAICompletionsProtocol();
  private readonly modelList: ModelInfo[];
  private readonly createClient: (apiKey: string, baseUrl: string) => ChatCompletionsClient;
  private readonly apiKey?: string;
  private client?: ChatCompletionsClient;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.name = options.name;
    this.baseUrl = options.baseUrl;
    this.modelList = options.models;
    const resolved = resolveAuth({ apiKeyEnv: options.apiKeyEnv, env: options.env });
    this.auth = resolved.auth;
    this.apiKey = resolved.apiKey;
    this.createClient = options.createClient ?? defaultCreateClient;
  }

  getModels(): ModelInfo[] {
    return this.modelList;
  }

  async *stream(modelId: string, context: Context): AsyncIterable<StreamEvent> {
    const request = this.protocol.buildRequest(context);
    const stream = await this.getClient().chat.completions.create({
      ...(request as Record<string, unknown>),
      model: modelId,
      stream: true,
    });
    yield* this.protocol.parseStream(stream);
  }

  private getClient(): ChatCompletionsClient {
    if (!this.apiKey) {
      throw new Error(`Provider ${this.id} 未配置认证：请设置环境变量`);
    }
    this.client ??= this.createClient(this.apiKey, this.baseUrl);
    return this.client;
  }
}

function defaultCreateClient(apiKey: string, baseUrl: string): ChatCompletionsClient {
  return new OpenAI({ baseURL: baseUrl, apiKey }) as unknown as ChatCompletionsClient;
}
