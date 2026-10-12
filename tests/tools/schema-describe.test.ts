import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Team } from "../../src/agent/team.js";
import { createSkillTool } from "../../src/skills/index.js";
import { createBuiltinTools, createCollaborationTools } from "../../src/tools/index.js";
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

describe("协作工具与 skill 工具的入参字段说明与输出上限提示", () => {
  const collabTools = createCollaborationTools({
    team: new Team(),
    getAgentPath: () => undefined,
    isReadOnly: () => false,
    createChildAgent: () => {
      throw new Error("schema 用例不执行工具");
    },
    sendMessage: async () => undefined,
    worktreeDefault: () => false,
  });
  const tools: Tool[] = [...collabTools, createSkillTool([])];

  it("六个协作工具与 skill 工具均在覆盖范围内", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "spawn_agent",
      "send_message",
      "followup_task",
      "list_agents",
      "wait_agent",
      "interrupt_agent",
      "skill",
    ]);
  });

  it("全部入参字段都带 description（list_agents 无入参字段）", () => {
    // 有字段的工具先确认字段非空，防空 schema 让下面的循环空转
    for (const name of ["spawn_agent", "send_message", "followup_task", "wait_agent", "interrupt_agent", "skill"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(Object.keys(schemaFields(tool)).length, `${name} 无任何字段`).toBeGreaterThan(0);
    }
    for (const tool of tools) {
      for (const [name, field] of Object.entries(schemaFields(tool))) {
        expect(field.description, `${tool.name}.${name} 缺字段说明`).toBeTruthy();
      }
    }
  });

  it("描述带截断落盘提示，上限数字与 maxResultSizeChars 同源", () => {
    for (const tool of tools) {
      expect(tool.description, tool.name).toContain("截断");
      expect(tool.description, tool.name).toContain("落盘");
      expect(tool.description, tool.name).toContain(String(tool.maxResultSizeChars));
    }
  });
});
