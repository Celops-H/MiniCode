import type { HookBus, HookEvent } from "../hooks/index.js";
import type { Logger } from "./logger.js";

/** 模型链切换原因的可读文案（事件里的 reason 为机器值） */
const FALLBACK_REASONS: Record<string, string> = {
  cooldown: "主模型冷却中",
  unresolved: "链上条目不可解析",
  error: "调用失败",
};

/** 权限决策来源的可读文案 */
const DECISION_SOURCES: Record<string, string> = {
  hook: "Hook",
  rule: "规则",
  user: "用户",
};

/**
 * 把 hook 事件流水接到日志（可观测性 B3 埋点，OBSERVABILITY §6）：
 * 模型请求耗时与结果、token 用量（debug）、fallback 决策、压缩动作、工具失败详情、
 * 权限拒绝。隐私口径：info 级不含消息正文与工具参数全文，参数只在 debug 级展开。
 * @param bus hook 事件总线
 * @param logger 流水日志
 * @returns 取消订阅函数（会话收尾用）
 */
export function attachHookLogging(bus: HookBus, logger: Logger): () => void {
  const unsubscribe: Array<() => void> = [
    bus.on("LlmCallEnd", (e) => {
      const result = e.error ? `失败（${e.error}）` : `完成（停因 ${e.stopReason ?? "未知"}）`;
      logger.info(`模型请求 ${e.model}：耗时 ${e.durationMs}ms，${result}`);
      const usage = e.usage;
      if (usage) {
        const parts = [
          `输入 ${usage.inputTokens ?? "-"}`,
          `输出 ${usage.outputTokens ?? "-"}`,
          `缓存读 ${usage.cacheReadTokens ?? "-"}`,
          `缓存写 ${usage.cacheWriteTokens ?? "-"}`,
        ];
        logger.debug(`token 用量 ${e.model}：${parts.join("，")}`);
      }
    }),
    bus.on("ModelFallback", (e) => {
      logger.info(`模型切换：${e.from} → ${e.to}（${FALLBACK_REASONS[e.reason] ?? e.reason}）`);
    }),
    bus.on("Compact", (e) => {
      const outcome = e.ok
        ? `完成：消息 ${e.messagesBefore} → ${e.messagesAfter} 条`
        : `失败${e.error ? `（${e.error}）` : ""}`;
      logger.info(`压缩${e.trigger === "auto" ? "（撞线自动）" : ""}${outcome}`);
    }),
    bus.on("PostToolUseFailure", (e) => {
      logger.info(`工具失败 ${e.toolName}：${e.error}`);
      // 参数全文只在 debug 级展开（隐私口径：info 不含工具参数全文）
      logger.debug(`工具失败参数 ${e.toolName}：${JSON.stringify(e.input)}`);
    }),
    bus.on("PermissionDecision", (e) => {
      if (e.decision === "deny") {
        logger.info(`权限拒绝 ${e.toolName}（来源 ${DECISION_SOURCES[e.source] ?? e.source}）`);
      }
    }),
  ];
  return () => {
    for (const off of unsubscribe) off();
  };
}

/** 处理器异常的日志行文案（宿主接 HookBus.onHandlerError 用） */
export function hookHandlerErrorText(error: unknown, event: HookEvent): string {
  const message = error instanceof Error ? error.message : String(error);
  return `hook 处理器异常（${event.type}）：${message}`;
}
