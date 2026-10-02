import type { HookEvent, HookEventOf, HookEventType, HookHandler, HookVerdict } from "./types.js";

/** 内部存储用的通用处理器签名（对外注册时按事件类型限定，emit 时事件已按类型分发） */
type AnyHandler = (event: HookEvent) => HookVerdict | void | Promise<HookVerdict | void>;

/** HookBus 构造选项 */
export interface HookBusOptions {
  /**
   * 处理器异常回调：单个 handler 抛错时调用（异常本身仍被吞掉，
   * 不影响同事件其余 handler 与业务）。宿主接流水日志，
   * 让 hook 故障从「静默吞掉」变成可排查。
   */
  onHandlerError?: (error: unknown, event: HookEvent) => void;
}

/**
 * Hook 事件总线：外部程序扩展 Agent 的出口。
 * on() 登记想监听的事件类型，emit() 广播事件并等所有处理器执行完，
 * 返回各自结果（PreToolUse 的拦截结果由权限决策链汇总）。
 */
export class HookBus {
  private readonly handlers = new Map<HookEventType, Set<AnyHandler>>();
  private readonly onHandlerError?: (error: unknown, event: HookEvent) => void;

  constructor(options: HookBusOptions = {}) {
    this.onHandlerError = options.onHandlerError;
  }

  /**
   * 注册事件处理器：该类型事件一发生就回调 handler，可异步；PreToolUse 的 handler 返回拦截结果。
   * @param type 要监听的事件类型
   * @param handler 处理器函数
   * @returns 取消注册函数：调用后该事件不再触发此处理器
   */
  on<T extends HookEventType>(
    type: T,
    handler: HookHandler<HookEventOf<T>>,
  ): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler as AnyHandler);
    this.handlers.set(type, set);
    return () => set.delete(handler as AnyHandler);
  }

  /**
   * 广播事件：把事件负载发给所有监听该类型的处理器，按注册顺序依次等待执行完。
   * @param event 事件负载
   * @returns 每个处理器的返回结果（PreToolUse 是拦截结果，其余是 void）
   */
  async emit(event: HookEvent): Promise<(HookVerdict | void)[]> {
    const handlers = this.handlers.get(event.type);
    if (!handlers) return [];
    const results: (HookVerdict | void)[] = [];
    for (const handler of handlers) {
      try {
        results.push(await handler(event));
      } catch (err) {
        // 单个 handler 异常不影响同事件其余 handler（事件处理出错不影响业务）；
        // 异常经回调上报宿主流水日志，不再静默吞掉。
        // 回调自身抛错同样吞掉：保证「handler 异常不向上抛、不连带丢后续 handler」无条件成立
        try {
          this.onHandlerError?.(err, event);
        } catch {
          // 回调故障忽略
        }
      }
    }
    return results;
  }
}