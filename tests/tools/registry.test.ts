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

/** 带 inputJsonSchema 的外部工具（MCP 形态，BACKEND §19）：zod 侧 z.unknown() 放行 */
const mcpTool: Tool = {
  name: "mcp__fs__read_file",
  description: "读取外部文件",
  inputSchema: z.unknown(),
  inputJsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  isReadOnly: false,
  requiresUserInteraction: false,
  maxResultSizeChars: 30000,
  execute: () => "外部内容",
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

  it("inputJsonSchema 原样透传不经 zod 转换（MCP 外部工具）", () => {
    const registry = new ToolRegistry();
    registry.register(mcpTool);
    const def = registry.definitions()[0];
    expect(def?.inputSchema).toBe(mcpTool.inputJsonSchema);
  });

  it("z.unknown() 放行任意入参（MCP 入参正确性交给 server 自校验）", () => {
    expect(mcpTool.inputSchema.parse({ any: ["shape", 1] })).toEqual({ any: ["shape", 1] });
  });
});
