import type { Context, StreamEvent } from "../core/index.js";
import type { Provider, ModelInfo } from "./types.js";
import { isSwitchableError, type ModelRouter } from "./router.js";

/** Models 构造选项 */
export interface ModelsOptions {
  /** 模型路由（可选）：配置后 stream 从优先级链选模型，可切换错误时切到备选 */
  router?: ModelRouter;
  /** 优先级链：主模型在前，备选在后；缺省退化为单模型 */
  chain?: string[];
}

/** Models 集合：注册 Provider、解析模型 → Provider、路由 stream 调用 */
export class Models {
  private readonly providers = new Map<string, Provider>();
  private readonly router?: ModelRouter;
  private readonly chain?: string[];

  constructor(options: ModelsOptions = {}) {
    this.router = options.router;
    this.chain = options.chain;
  }

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
   * 按模型 id 路由到对应 Provider 的流式调用。配置了 router 时从优先级链选模型：
   * 可切换错误（限流/5xx/网络等）切到下一个健康模型，每个模型最多试一次；
   * 不可切换错误（参数/认证）或已产出内容后直接上抛，避免混流。
   * @param modelId 模型 id（路由模式下为优先级链主模型）
   * @param context 一次模型调用的完整输入
   * @returns 统一事件流
   */
  async *stream(
    modelId: string,
    context: Context,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<StreamEvent> {
    if (!this.router) {
      const resolved = this.resolve(modelId);
      if (!resolved) {
        throw new Error(`未知模型：${modelId}`);
      }
      yield* resolved.provider.stream(modelId, context, options);
      return;
    }
    // 路由模式：select 跳过冷却中的模型；失败记冷却后重选，直到成功或整链尝试过。
    // 传入的 modelId（-m 或 TUI /model 选定）打头，配置的 modelChain 作备选路由（对齐 buildModelClient）
    const router = this.router;
    const chain = modelId ? [modelId, ...(this.chain ?? []).filter((m) => m !== modelId)] : this.chain ?? [modelId];
    let selected = router.select(chain);
    // 轮开始 select 跳过冷却中的主模型直接从备选起步：同样发切换观察事件——agent 侧
    // effectiveModel 与 TUI 署名都靠它知道实际产出者，用户也能看到「已切换」而非静默换模型
    if (selected && selected !== chain[0]) {
      yield { type: "model_fallback", from: chain[0]!, to: selected };
    }
    const tried = new Set<string>();
    let lastError: unknown;
    while (selected && !tried.has(selected)) {
      tried.add(selected);
      const resolved = this.resolve(selected);
      if (!resolved) {
        // 链上不可解析条目（模型下线、厂商 key 已删后未注册）跳过继续下一个（E54）：
        // 直接抛「未知模型」会中断路由、遮蔽后续条目的真实错误。记失败进冷却让 select
        // 不再选中它；lastError 只在还没有真实厂商错误时赋值，整链尝试完后上抛的
        // 始终是最后的真实错误（review 补：真实失败在前时不被「未知模型」反向遮蔽）
        lastError ??= new Error(`未知模型：${selected}`);
        router.recordFailure(selected);
        const next = router.select(chain);
        // 只在真的换了一个未尝试的模型时发观察事件：select 全挂兜底会返回链首，
        // 链首若是自身或已试过的模型，发「已切换」就是虚假通知（review 补）
        if (next && !tried.has(next)) yield { type: "model_fallback", from: selected, to: next };
        selected = next;
        continue;
      }
      let contentEmitted = false;
      let streamFailed = false;
      try {
        for await (const event of resolved.provider.stream(selected, context, options)) {
          // 流内产出 error 事件（厂商报错/意外断流）不算成功，路由健康度不虚标；
          // 也不算「已吐出内容」（E57 审查补充）——首 token 前的厂商故障（空闲超时、
          // 流内 error 后异常收尾）仍可切换备选，与 BACKEND §6 的排除条件对齐。
          // done 等 非 error 事件都置位：厂商宣告正常完成（done 收尾）不进冷却
          if (event.type === "error") streamFailed = true;
          else contentEmitted = true;
          yield event;
        }
        if (streamFailed) {
          // 以 error 收尾对齐异常路径记健康度（E57）：未产出任何内容记失败进冷却——
          // 否则报错厂商永不进冷却，每次请求都先撞一遍再失败；已产出内容属半截响应，不误标
          if (!contentEmitted) router.recordFailure(selected);
        } else {
          router.recordSuccess(selected);
        }
        return;
      } catch (err) {
        lastError = err;
        // 用户打断（signal 已中止）：控制流而非模型故障，直接上抛——不切备选不标冷却
        // （否则会带着已中止的 signal 挨个真实请求备选链，白白计费）
        if (options?.signal?.aborted) throw err;
        // 确定性错误或已吐出内容（切换会混流）：直接上抛；error 事件不算内容，
        // 首 token 前的故障仍走下面的切换（E57 审查补充）
        if (!isSwitchableError(err) || contentEmitted) throw err;
        router.recordFailure(selected);
        const next = router.select(chain);
        // 主模型失败、切换备选：发观察事件（TUI 常驻通知行「已切换」），避免静默路由——
        // 用户主动切的模型不可用时能知道发生了什么，而不是只见「运行中」干等。
        // 但只在真的换了一个未尝试的模型时才发：select 全挂兜底会返回链首，链首若是
        // 自身或已试过的模型，发「已切换」就是虚假通知（review 补）
        if (next && !tried.has(next)) yield { type: "model_fallback", from: selected, to: next };
        selected = next;
      }
    }
    throw lastError ?? new Error("模型调用全部失败");
  }
}
