import { describe, expect, it } from "vitest";
import {
  evaluateRules,
  parseRuleString,
  ruleMatches,
  wildcardMatch,
} from "../../src/permission/index.js";

describe("parseRuleString", () => {
  it("整工具规则（无括号）", () => {
    expect(parseRuleString("bash", "allow")).toEqual({ toolName: "bash", behavior: "allow" });
  });

  it("内容级规则", () => {
    expect(parseRuleString("bash(rm:*)", "deny")).toEqual({
      toolName: "bash",
      pattern: "rm:*",
      behavior: "deny",
    });
  });

  it("空括号与 * 视为整工具规则", () => {
    expect(parseRuleString("bash()", "ask")).toEqual({ toolName: "bash", behavior: "ask" });
    expect(parseRuleString("bash(*)", "ask")).toEqual({ toolName: "bash", behavior: "ask" });
  });

  it("去首尾空白", () => {
    expect(parseRuleString("  read  ", "allow").toolName).toBe("read");
  });
});

describe("ruleMatches", () => {
  it("整工具规则匹配任意内容", () => {
    const rule = parseRuleString("read", "allow");
    expect(ruleMatches(rule, "read", "a.ts")).toBe(true);
    expect(ruleMatches(rule, "write", "a.ts")).toBe(false);
  });

  it("内容级规则按通配匹配", () => {
    const rule = parseRuleString("bash(npm run *)", "allow");
    expect(ruleMatches(rule, "bash", "npm run build")).toBe(true);
    expect(ruleMatches(rule, "bash", "npm install")).toBe(false);
  });

  it("内容级规则无内容参数时不匹配", () => {
    const rule = parseRuleString("bash(rm *)", "deny");
    expect(ruleMatches(rule, "bash")).toBe(false);
  });
});

describe("evaluateRules（deny 优先，默认 ask）", () => {
  it("deny 命中返回 deny", () => {
    const rules = [
      parseRuleString("bash(rm *)", "deny"),
      parseRuleString("bash", "allow"),
    ];
    expect(evaluateRules(rules, "bash", "rm -rf /")).toBe("deny");
  });

  it("ask 优先于 allow", () => {
    const rules = [
      parseRuleString("bash", "allow"),
      parseRuleString("bash(sudo *)", "ask"),
    ];
    expect(evaluateRules(rules, "bash", "sudo apt install")).toBe("ask");
  });

  it("无规则命中默认 ask（保守）", () => {
    expect(evaluateRules([], "bash", "ls")).toBe("ask");
  });

  it("allow 命中且无 deny/ask 时返回 allow", () => {
    const rules = [parseRuleString("read", "allow")];
    expect(evaluateRules(rules, "read", "a.ts")).toBe("allow");
  });
});

describe("wildcardMatch", () => {
  it("* 匹配任意片段", () => {
    expect(wildcardMatch("*.env", "prod.env")).toBe(true);
    expect(wildcardMatch("*.env", "a/b.env")).toBe(true);
  });

  it("? 匹配单个字符", () => {
    expect(wildcardMatch("a?.ts", "ab.ts")).toBe(true);
    expect(wildcardMatch("a?.ts", "abc.ts")).toBe(false);
  });

  it("大小写不敏感", () => {
    expect(wildcardMatch("npm run *", "NPM RUN BUILD")).toBe(true);
  });
});
