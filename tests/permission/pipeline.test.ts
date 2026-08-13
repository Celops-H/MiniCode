import { describe, expect, it } from "vitest";
import {
  PermissionPipeline,
  parseRuleString,
} from "../../src/permission/index.js";

describe("权限决策管线", () => {
  it("规则层 allow 直接放行", async () => {
    const pipeline = new PermissionPipeline({
      rules: [parseRuleString("read", "allow")],
      approver: async () => {
        throw new Error("不应触发审批");
      },
    });
    const result = await pipeline.check({ toolName: "read", content: "a.ts" });
    expect(result).toMatchObject({ allowed: true, source: "rule" });
  });

  it("规则层 deny 拒绝并带原因", async () => {
    const pipeline = new PermissionPipeline({
      rules: [parseRuleString("bash(rm *)", "deny")],
    });
    const result = await pipeline.check({ toolName: "bash", content: "rm -rf /tmp/x" });
    expect(result).toMatchObject({ allowed: false, source: "rule" });
  });

  it("危险命令硬拒绝，不进入审批", async () => {
    let approverCalled = false;
    const pipeline = new PermissionPipeline({
      rules: [parseRuleString("bash", "allow")],
      approver: async () => {
        approverCalled = true;
        return { action: "allow" };
      },
    });
    const result = await pipeline.check({ toolName: "bash", content: 'eval "rm -rf /"' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("危险命令");
    expect(approverCalled).toBe(false);
  });

  it("ask 进入用户审批，allow 放行", async () => {
    const pipeline = new PermissionPipeline({
      rules: [],
      approver: async () => ({ action: "allow" }),
    });
    const result = await pipeline.check({ toolName: "bash", content: "git status" });
    expect(result).toMatchObject({ allowed: true, source: "approver" });
  });

  it("ask 用户拒绝，拒绝并带原因", async () => {
    const pipeline = new PermissionPipeline({
      rules: [],
      approver: async () => ({ action: "deny", reason: "用户说不用了" }),
    });
    const result = await pipeline.check({ toolName: "bash", content: "rm x" });
    expect(result).toMatchObject({ allowed: false, reason: "用户说不用了" });
  });

  it("remember 后同调用走会话缓存，不再询问", async () => {
    let approverCalls = 0;
    const pipeline = new PermissionPipeline({
      rules: [],
      approver: async () => {
        approverCalls++;
        return { action: "allow", remember: true };
      },
    });
    const request = { toolName: "bash", content: "npm install" };

    const first = await pipeline.check(request);
    expect(first.allowed).toBe(true);

    const second = await pipeline.check(request);
    expect(second).toMatchObject({ allowed: true, source: "cache" });
    expect(approverCalls).toBe(1);
  });

  it("未配置审批处理时 ask 拒绝", async () => {
    const pipeline = new PermissionPipeline({ rules: [] });
    const result = await pipeline.check({ toolName: "bash", content: "ls" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("未配置审批");
  });

  it("危险命令检查仅作用于 bash 工具", async () => {
    const pipeline = new PermissionPipeline({
      rules: [],
      approver: async () => ({ action: "allow" }),
    });
    // read 工具的内容含 eval 不触发危险检查（危险检查只对 bash）
    const result = await pipeline.check({ toolName: "read", content: '文件内容 eval "x"' });
    expect(result.allowed).toBe(true);
  });
});
