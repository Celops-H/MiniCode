import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createBuiltinTools } from "../../src/tools/index.js";
import type { Tool } from "../../src/tools/index.js";

interface SchemaField {
  description?: string;
  items?: { properties?: Record<string, SchemaField> };
}

/** 工具入参 JSON Schema 的顶层字段（即模型侧实际收到的参数说明） */
function schemaFields(tool: Tool): Record<string, SchemaField> {
  const json = z.toJSONSchema(tool.inputSchema) as { properties?: Record<string, SchemaField> };
  return json.properties ?? {};
}

describe("内置工具入参字段说明与输出上限提示", () => {
  const tools = createBuiltinTools();

  it("全部入参字段都带 description（数组元素的子字段同样要求）", () => {
    for (const tool of tools) {
      const props = schemaFields(tool);
      expect(Object.keys(props).length, `${tool.name} 无任何字段`).toBeGreaterThan(0);
      for (const [name, field] of Object.entries(props)) {
        expect(field.description, `${tool.name}.${name} 缺字段说明`).toBeTruthy();
        for (const [inner, innerField] of Object.entries(field.items?.properties ?? {})) {
          expect(innerField.description, `${tool.name}.${name}[].${inner} 缺字段说明`).toBeTruthy();
        }
      }
    }
  });

  it("输出可能超限的工具描述带截断落盘提示，上限数字与 maxResultSizeChars 同源", () => {
    for (const tool of tools) {
      // write/edit 的结果是一行确认文本，不会超限截断，不提示
      if (tool.name === "write" || tool.name === "edit") continue;
      expect(tool.description, tool.name).toContain("截断");
      expect(tool.description, tool.name).toContain("落盘");
      expect(tool.description, tool.name).toContain(String(tool.maxResultSizeChars));
    }
  });
});
