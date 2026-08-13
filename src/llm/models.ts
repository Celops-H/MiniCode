import type { Context, StreamEvent } from "../core/index.js";
import type { Provider, ModelInfo } from "./types.js";

/** Models 集合：注册 Provider、解析模型 → Provider、路由 stream 调用 */
export class Models {
  private readonly providers = new Map<string, Provider>();

  /**
   * 注册一个 Provider 到集合。
   * @param provider 待注册的 Provider
   */
  register(provider: Provider): void {
    this.providers.set(provider.id, provider);
  }

  /**
   * 按 provider id 查找。
   * @param providerId 提供商 id
   * @returns 对应 Provider；未注册返回 undefined
   */
  provider(providerId: string): Provider | undefined {
    return this.providers.get(providerId);
  }

  /**
   * 汇总全部可用模型。
   * @returns 所有 Provider 的模型列表
   */
  listModels(): ModelInfo[] {
    return [...this.providers.values()].flatMap((p) => p.getModels());
  }

  /**
   * 根据模型 id 定位其所属 Provider 与模型定义。
   * @param modelId 模型 id
   * @returns 含 Provider 与模型信息；未找到返回 undefined
   */
  resolve(modelId: string): { provider: Provider; model: ModelInfo } | undefined {
    for (const provider of this.providers.values()) {
      const model = provider.getModels().find((m) => m.id === modelId);
      if (model) return { provider, model };
    }
    return undefined;
  }

  /**
   * 按模型 id 路由到对应 Provider 的流式调用。
   * @param modelId 模型 id
   * @param context 一次模型调用的完整输入
   * @returns 统一事件流
   */
  async *stream(modelId: string, context: Context): AsyncIterable<StreamEvent> {
    const resolved = this.resolve(modelId);
    if (!resolved) {
      throw new Error(`未知模型：${modelId}`);
    }
    yield* resolved.provider.stream(modelId, context);
  }
}
