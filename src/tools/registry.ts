import { z } from "zod";
import type { ToolDefinition } from "../core/index.js";
import type { Tool } from "./base.js";

/** 工具注册表：注册、查找、序列化为模型可见的工具定义 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /** 注册工具；同名覆盖 */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** 序列化为模型可见定义：zod schema 转标准 JSON Schema */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    }));
  }
}
