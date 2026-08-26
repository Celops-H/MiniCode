/**
 * 判断错误是否属于「可切换」类（DESIGN 5.2）：
 * 路由遇到这类错误时计数并切换到备选模型；反之（参数/认证/权限等确定性错误）
 * 不计数、直接上抛，切换也无济于事。
 * 分类依据：429（限流）/5xx（服务器）/408（请求超时）/409（锁冲突）/无 HTTP 状态
 * （网络、连接、超时）→ 可切换；400/401/403/404 → 直接报错。
 * status 用 duck-typing 提取，不依赖具体 SDK 错误类型（各厂商错误均带 status 属性）。
 * @param error 捕获的错误对象
 * @returns 是否可切换
 */
export function isSwitchableError(error: unknown): boolean {
  const status = (error as { status?: number } | null | undefined)?.status;
  if (status === undefined) return true; // 无 HTTP 状态：网络/连接/超时错误，可切换
  if (status === 408 || status === 409 || status === 429) return true; // 超时/冲突/限流
  if (status >= 500) return true; // 服务器内部错误
  return false; // 参数、认证、权限、模型不存在等确定性错误
}

/** 路由配置项（均可选，用默认值） */
export interface RouterOptions {
  /** 单次失败的短冷却 ms，默认 2min（该时间内直接跳过，不再半开试探反复干等） */
  cooldownMs?: number;
  /** 连续失败达阈值后的熔断冷却 ms，默认 10min（熔断期内直接跳过，试探频率低） */
  circuitBreakerMs?: number;
  /** 连续失败熔断阈值，默认 3 */
  maxFailures?: number;
  /** 恢复确认：熔断恢复后连续成功达阈值才算完全健康，默认 2 */
  confirmCount?: number;
}

/** 单模型健康状态（内部） */
interface ModelHealth {
  /** 连续失败数 */
  failures: number;
  /** 冷却/熔断到期时间戳 ms；0 = 无冷却（完全健康） */
  cooldownUntil: number;
  /** 恢复确认连续成功计数 */
  successStreak: number;
}

/**
 * 模型路由状态机（DESIGN 5.2）：维护优先级链上每个模型的健康度。
 * select 按链序选模型，失败短冷却、连续失败熔断，成功带恢复确认。
 * 半开探测：冷却到期后 select 放行真实请求试探（DESIGN 5.3：商业 API 无健康检查端点，
 * 探测即计费，半开用真实请求验证，无额外开销）。
 */
export class ModelRouter {
  private readonly cooldownMs: number;
  private readonly circuitBreakerMs: number;
  private readonly maxFailures: number;
  private readonly confirmCount: number;
  private readonly health = new Map<string, ModelHealth>();

  constructor(options: RouterOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? 120_000;
    this.circuitBreakerMs = options.circuitBreakerMs ?? 600_000;
    this.maxFailures = options.maxFailures ?? 3;
    this.confirmCount = options.confirmCount ?? 2;
  }

  /**
   * 按优先级链选择模型：返回第一个「可用」模型（无冷却或冷却已到期=半开放行）；
   * 整条链都不可用时返回链首（全挂兜底：最后一次尝试机会）。
   * @param chain 优先级链：主模型在前，备选在后
   * @returns 选中的模型 id；链为空返回 undefined
   */
  select(chain: string[]): string | undefined {
    if (chain.length === 0) return undefined;
    for (const id of chain) {
      if (this.isAvailable(id)) return id;
    }
    return chain[0]; // 全挂兜底：整链都在冷却，返回链首
  }

  /**
   * 记录一次可切换失败：失败数 +1，未达阈值短冷却、达阈值熔断（更长冷却）；
   * 同时清零恢复确认连击——失败打破连续成功。
   * @param modelId 模型 id
   */
  recordFailure(modelId: string): void {
    const health = this.getHealth(modelId);
    health.failures += 1;
    health.successStreak = 0;
    health.cooldownUntil =
      Date.now() + (health.failures >= this.maxFailures ? this.circuitBreakerMs : this.cooldownMs);
  }

  /**
   * 记录一次成功：清零失败计数；冷却到期后的连续成功达确认阈值才算完全健康。
   * @param modelId 模型 id
   */
  recordSuccess(modelId: string): void {
    const health = this.getHealth(modelId);
    health.failures = 0;
    health.successStreak += 1;
    if (health.successStreak >= this.confirmCount) {
      health.cooldownUntil = 0; // 完全健康：无冷却
    }
  }

  /**
   * 查询模型是否完全健康（无冷却且恢复确认完成）。
   * @param modelId 模型 id
   * @returns 是否完全健康
   */
  isHealthy(modelId: string): boolean {
    const health = this.health.get(modelId);
    return !health || health.cooldownUntil === 0;
  }

  private getHealth(modelId: string): ModelHealth {
    let health = this.health.get(modelId);
    if (!health) {
      health = { failures: 0, cooldownUntil: 0, successStreak: 0 };
      this.health.set(modelId, health);
    }
    return health;
  }

  /** 可用 = 无冷却记录，或冷却已到期（半开放行真实请求试探） */
  private isAvailable(modelId: string): boolean {
    const health = this.health.get(modelId);
    return !health || health.cooldownUntil <= Date.now();
  }
}
