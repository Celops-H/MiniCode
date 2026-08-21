import { checkDangerousCommand } from "./dangerous.js";
import { evaluateRules, ruleMatches, type PermissionBehavior, type PermissionRule } from "./rule.js";

/** 权限模式（DESIGN 8.3，用户选定 1/3/4）：default 正常审批 / plan 只读放行 / bypassPermissions 跳过默认询问 */
export type PermissionMode = "default" | "plan" | "bypassPermissions";

export interface PermissionRequest {
  toolName: string;
  /** 工具参数内容（bash 为命令原文） */
  content?: string;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  source: "rule" | "cache" | "hook" | "approver" | "dangerous" | "mode";
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
  /** 权限模式，缺省 default（正常审批） */
  mode?: PermissionMode;
  /** plan 模式放行的只读工具集合（宿主从 Tool.isReadOnly 收集） */
  readOnlyTools?: Set<string>;
}

/**
 * 权限决策管线：危险命令检查 → 规则层 → 会话缓存 → Hook → 用户审批。
 * 规则层是前置过滤器，deny 优先；仅 ask 进入后续决策链。
 * 三种模式（DESIGN 8.3）：
 * - default：完整审批链
 * - plan：只放行注入的只读工具集合，其余拒绝
 * - bypassPermissions：跳过「默认询问」（未命中规则），但保留危险命令检查与显式规则
 */
export class PermissionPipeline {
  private readonly cache = new Map<string, boolean>();

  constructor(private readonly options: PermissionPipelineOptions) {}

  /**
   * 对一次工具调用做权限裁决。
   * @param request 权限请求（工具名 + 参数内容）
   * @returns 裁决结果（是否放行 + 来源 + 拒绝原因）
   */
  async check(request: PermissionRequest): Promise<PermissionResult> {
    const { toolName, content } = request;
    const mode = this.options.mode ?? "default";

    // plan 模式：只放行只读工具集合，其余拒绝（危险命令检查无需再做，bash 不在只读集合）
    if (mode === "plan") {
      if (this.options.readOnlyTools?.has(toolName)) {
        return { allowed: true, source: "mode" };
      }
      return { allowed: false, reason: `plan 模式只读：${toolName} 不可用`, source: "mode" };
    }

    // bash 工具先做危险命令检查（硬拒绝，保守，bypass 模式同样生效）
    if (toolName === "bash" && content !== undefined) {
      const dangerous = checkDangerousCommand(content);
      if (dangerous.dangerous) {
        return { allowed: false, reason: `危险命令：${dangerous.reason}`, source: "dangerous" };
      }
    }

    // 规则层：deny 优先，allow 放行，ask 区分「显式 ask 规则」与「未命中规则（默认 ask）」
    const verdict = evaluateRules(this.options.rules, toolName, content);
    if (verdict === "allow") return { allowed: true, source: "rule" };
    if (verdict === "deny") return { allowed: false, reason: "规则拒绝", source: "rule" };
    const explicitAsk = this.options.rules.some(
      (rule) => rule.behavior === "ask" && ruleMatches(rule, toolName, content),
    );
    // bypass 模式：跳过「默认询问」，显式 ask 规则仍生效（参考 cc：显式规则优先于 bypass）
    if (mode === "bypassPermissions" && !explicitAsk) {
      return { allowed: true, source: "mode" };
    }

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

  /**
   * 生成会话缓存键（整工具调用或无内容参数用工具名，否则 `Tool(content)`）。
   * @param toolName 工具名
   * @param content 工具参数内容，可省略
   * @returns 缓存键
   */
  private cacheKey(toolName: string, content?: string): string {
    return content === undefined ? toolName : `${toolName}(${content})`;
  }
}
