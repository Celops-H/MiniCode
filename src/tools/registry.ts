import { z } from "zod";
import type { ToolDefinition } from "../core/index.js";
import type { Tool } from "./base.js";

/** 工具注册表：注册、查找、序列化为模型可见的工具定义 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /**
   * 注册工具；同名覆盖。
   * @param tool 待注册的工具
   */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * 按工具名查找。
   * @param name 工具名
   * @returns 对应工具；未注册返回 undefined
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * 列出全部已注册工具。
   * @returns 工具数组
   */
  list(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * 序列化为模型可见的工具定义：有 inputJsonSchema 的（MCP 外部工具）原样透传，
   * 其余 zod schema 转标准 JSON Schema。
   * @returns 工具定义数组
   */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputJsonSchema ?? (z.toJSONSchema(tool.inputSchema) as Record<string, unknown>),
    }));
  }
}
