import { checkDangerousCommand } from "./dangerous.js";
import { evaluateRules, type PermissionBehavior, type PermissionRule } from "./rule.js";

export interface PermissionRequest {
  toolName: string;
  /** 工具参数内容（bash 为命令原文） */
  content?: string;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  source: "rule" | "cache" | "hook" | "approver" | "dangerous";
}

export type PermissionDecision =
  | { action: "allow"; remember?: boolean }
  | { action: "deny"; reason?: string };

/** 用户审批函数：ask 时调用，由宿主注入（CLI 弹窗 / 测试 mock） */
export type PermissionApprover = (request: PermissionRequest) => Promise<PermissionDecision>;

/** PreToolUse 钩子插入点：M3 接入 Hook 系统 */
export type PreToolUseHook = (
  request: PermissionRequest,
) => Promise<PermissionBehavior | undefined>;

export interface PermissionPipelineOptions {
  rules: PermissionRule[];
  approver?: PermissionApprover;
  preToolUseHook?: PreToolUseHook;
}

/**
 * 权限决策管线：危险命令检查 → 规则层 → 会话缓存 → Hook → 用户审批。
 * 规则层是前置过滤器，deny 优先；仅 ask 进入后续决策链。
 */
export class PermissionPipeline {
  private readonly cache = new Map<string, boolean>();

  constructor(private readonly options: PermissionPipelineOptions) {}

  async check(request: PermissionRequest): Promise<PermissionResult> {
    const { toolName, content } = request;

    // bash 工具先做危险命令检查（硬拒绝，保守）
    if (toolName === "bash" && content !== undefined) {
      const dangerous = checkDangerousCommand(content);
      if (dangerous.dangerous) {
        return { allowed: false, reason: `危险命令：${dangerous.reason}`, source: "dangerous" };
      }
    }

    // 规则层
    const verdict = evaluateRules(this.options.rules, toolName, content);
    if (verdict === "allow") return { allowed: true, source: "rule" };
    if (verdict === "deny") return { allowed: false, reason: "规则拒绝", source: "rule" };

    // ask：会话缓存命中则直接放行
    const cacheKey = this.cacheKey(toolName, content);
    if (this.cache.get(cacheKey)) return { allowed: true, source: "cache" };

    // Hook 插入点（M3 实现）
    if (this.options.preToolUseHook) {
      const hookVerdict = await this.options.preToolUseHook(request);
      if (hookVerdict === "deny") return { allowed: false, reason: "Hook 拒绝", source: "hook" };
      if (hookVerdict === "allow") return { allowed: true, source: "hook" };
    }

    // 用户审批
    if (!this.options.approver) {
      return { allowed: false, reason: "需要审批但未配置审批处理", source: "approver" };
    }
    const decision = await this.options.approver(request);
    if (decision.action === "allow") {
      if (decision.remember) this.cache.set(cacheKey, true);
      return { allowed: true, source: "approver" };
    }
    return { allowed: false, reason: decision.reason ?? "用户拒绝", source: "approver" };
  }

  private cacheKey(toolName: string, content?: string): string {
    return content === undefined ? toolName : `${toolName}(${content})`;
  }
}
