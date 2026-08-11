import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../src/tools/index.js";
import type { Tool } from "../../src/tools/index.js";

const readTool: Tool = {
  name: "read",
  description: "读取文件内容",
  inputSchema: z.object({ path: z.string(), startLine: z.number().optional() }),
  isReadOnly: true,
  requiresUserInteraction: false,
  maxResultSizeChars: 1000,
  execute: () => "内容",
};

const globTool: Tool = {
  name: "glob",
  description: "按模式匹配文件",
  inputSchema: z.object({ pattern: z.string() }),
  isReadOnly: true,
  requiresUserInteraction: false,
  maxResultSizeChars: 1000,
  execute: () => "[]",
};

describe("ToolRegistry", () => {
  it("注册后可按名查找与列出", () => {
    const registry = new ToolRegistry();
    registry.register(readTool);
    registry.register(globTool);
    expect(registry.get("read")).toBe(readTool);
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.list().map((t) => t.name)).toEqual(["read", "glob"]);
  });

  it("同名注册覆盖旧工具", () => {
    const registry = new ToolRegistry();
    registry.register(readTool);
    registry.register({ ...readTool, description: "新版读取" });
    expect(registry.get("read")?.description).toBe("新版读取");
    expect(registry.list()).toHaveLength(1);
  });

  it("definitions 序列化为模型可见的工具定义", () => {
    const registry = new ToolRegistry();
    registry.register(readTool);
    const defs = registry.definitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ name: "read", description: "读取文件内容" });
    // zod schema 应转为标准 JSON Schema
    expect(defs[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        path: { type: "string" },
      },
    });
  });
});
