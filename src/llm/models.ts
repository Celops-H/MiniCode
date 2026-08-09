import type { Context, StreamEvent } from "../core/index.js";
import type { Provider, ModelInfo } from "./types.js";

/** Models 集合：注册 Provider、解析模型 → Provider、路由 stream 调用 */
export class Models {
  private readonly providers = new Map<string, Provider>();

  register(provider: Provider): void {
    this.providers.set(provider.id, provider);
  }

  provider(providerId: string): Provider | undefined {
    return this.providers.get(providerId);
  }

  /** 汇总全部可用模型 */
  listModels(): ModelInfo[] {
    return [...this.providers.values()].flatMap((p) => p.getModels());
  }

  /** 根据模型 id 解析其 Provider */
  resolve(modelId: string): { provider: Provider; model: ModelInfo } | undefined {
    for (const provider of this.providers.values()) {
      const model = provider.getModels().find((m) => m.id === modelId);
      if (model) return { provider, model };
    }
    return undefined;
  }

  /** 路由到对应 Provider 的 stream 调用 */
  async *stream(modelId: string, context: Context): AsyncIterable<StreamEvent> {
    const resolved = this.resolve(modelId);
    if (!resolved) {
      throw new Error(`未知模型：${modelId}`);
    }
    yield* resolved.provider.stream(modelId, context);
  }
}
