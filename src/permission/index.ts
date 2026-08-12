export {
  parseRuleString,
  ruleMatches,
  evaluateRules,
  wildcardMatch,
} from "./rule.js";
export type { PermissionBehavior, PermissionRule } from "./rule.js";
export { checkDangerousCommand } from "./dangerous.js";
export type { DangerousCheckResult } from "./dangerous.js";
