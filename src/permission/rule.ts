/**
 * 权限规则层：allow / deny / ask 三态规则。
 * 规则是前置过滤器——主循环在工具执行前用规则做第一道裁决。
 * 参考实现已调研（opencode 的 Rule{action,resource,effect}、claude-code 的三桶规则）。
 */

export type PermissionBehavior = "allow" | "deny" | "ask";

export interface PermissionRule {
  /** 工具名，如 "bash"、"read" */
  toolName: string;
  /** 内容级模式，省略表示整工具级规则；有值则按通配匹配工具参数 */
  pattern?: string;
  behavior: PermissionBehavior;
}

/**
 * 从规则字符串解析出规则。
 * 格式：`Tool`（整工具）或 `Tool(content)`（内容级）。
 * `Tool()`、`Tool(*)` 视为整工具规则（pattern 省略）。
 */
export function parseRuleString(input: string, behavior: PermissionBehavior): PermissionRule {
  const trimmed = input.trim();
  const openIdx = trimmed.indexOf("(");
  if (openIdx === -1) {
    return { toolName: trimmed, behavior };
  }

  const toolName = trimmed.slice(0, openIdx);
  const closeIdx = trimmed.lastIndexOf(")");
  const pattern = trimmed.slice(openIdx + 1, closeIdx === -1 ? trimmed.length : closeIdx);

  if (pattern === "" || pattern === "*") {
    return { toolName, behavior };
  }
  return { toolName, pattern, behavior };
}

/** 规则是否命中某次工具调用；无内容参数时不匹配内容级规则 */
export function ruleMatches(rule: PermissionRule, toolName: string, content?: string): boolean {
  if (rule.toolName !== toolName) return false;
  if (rule.pattern === undefined) return true;
  if (content === undefined) return false;
  return wildcardMatch(rule.pattern, content);
}

/**
 * 对一批规则求裁决：deny 优先，其次 ask，其次 allow，都不命中默认 ask（保守）。
 * deny 优先保证「危险规则的拒绝不会被宽松规则放行」。
 */
export function evaluateRules(
  rules: PermissionRule[],
  toolName: string,
  content?: string,
): PermissionBehavior {
  for (const rule of rules) {
    if (rule.behavior === "deny" && ruleMatches(rule, toolName, content)) return "deny";
  }
  for (const rule of rules) {
    if (rule.behavior === "ask" && ruleMatches(rule, toolName, content)) return "ask";
  }
  for (const rule of rules) {
    if (rule.behavior === "allow" && ruleMatches(rule, toolName, content)) return "allow";
  }
  return "ask";
}

/** 通配匹配：`*` 匹配任意片段，`?` 匹配单个字符，大小写不敏感 */
export function wildcardMatch(pattern: string, input: string): boolean {
  let regex = "^";
  for (const ch of pattern) {
    if (ch === "*") regex += ".*";
    else if (ch === "?") regex += ".";
    else regex += escapeRegExp(ch);
  }
  regex += "$";
  return new RegExp(regex, "i").test(input);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
