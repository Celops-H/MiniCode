import { describe, expect, it } from "vitest";
import { AgentPath } from "../../src/agent/agent-path.js";

describe("AgentPath（agent 层级路径）", () => {
  it("root 固定为 /root，isRoot/name 正确", () => {
    const root = AgentPath.root();
    expect(root.toString()).toBe("/root");
    expect(root.isRoot()).toBe(true);
    expect(root.name()).toBe("root");
  });

  it("join 派生直接子路径", () => {
    const child = AgentPath.root().join("task_1");
    expect(typeof child).not.toBe("string");
    expect((child as AgentPath).toString()).toBe("/root/task_1");
    expect((child as AgentPath).name()).toBe("task_1");
    expect((child as AgentPath).isRoot()).toBe(false);
  });

  it("resolve 支持相对与绝对引用", () => {
    const current = AgentPath.parse("/root/researcher");
    const worker = (current as AgentPath).resolve("worker");
    expect((worker as AgentPath).toString()).toBe("/root/researcher/worker");
    const absolute = (current as AgentPath).resolve("/root/other");
    expect((absolute as AgentPath).toString()).toBe("/root/other");
    expect(((current as AgentPath).resolve("/root") as AgentPath).isRoot()).toBe(true);
  });

  it("非法路径/段名返回错误文本", () => {
    expect(typeof AgentPath.parse("/not-root")).toBe("string");
    expect(typeof AgentPath.parse("/root/task_1/")).toBe("string");
    expect(typeof AgentPath.parse("/root/BadName")).toBe("string");
    expect(typeof AgentPath.root().join("BadName")).toBe("string");
    expect(typeof AgentPath.root().join("")).toBe("string");
    expect(typeof AgentPath.root().join("root")).toBe("string");
    expect(typeof AgentPath.root().join("..")).toBe("string");
    expect(typeof AgentPath.root().join("a/b")).toBe("string");
    expect(typeof (AgentPath.parse("/root/task_1") as AgentPath).resolve("../sibling")).toBe("string");
  });
});