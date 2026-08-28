import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleSessionExtensions } from "../../src/cli/app.js";
import { writeFakeServer } from "../mcp/helpers.js";

describe("assembleSessionExtensions（扩展生态装配）", () => {
  const managers: Array<{ stopAll(): void }> = [];
  let tmpDir: string;
  let serverFile: string | null = null;

  afterEach(() => {
    for (const m of managers.splice(0)) m.stopAll();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 造项目技能目录并返回路径 */
  function makeSkill(name: string, content: string): string {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-assemble-"));
    const dir = path.join(tmpDir, "skills");
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, name, "SKILL.md"), content);
    return dir;
  }

  it("未配置 MCP 与技能时产出空装配", async () => {
    const ext = await assembleSessionExtensions({});
    expect(ext.tools).toEqual([]);
    expect(ext.promptSection).toBe("");
    expect(ext.mcpManager).toBeNull();
    expect(ext.mcpErrors).toEqual([]);
  });

  it("技能非空时产出 skill 工具与「可用技能」提示词段（工具与提示词同进退）", async () => {
    const dir = makeSkill("review", "---\nname: review\ndescription: 代码审查\n---\n审查正文");
    const ext = await assembleSessionExtensions({}, { projectSkillsDir: dir });
    expect(ext.tools.map((t) => t.name)).toEqual(["skill"]);
    expect(ext.promptSection).toContain("【可用技能】");
    expect(ext.promptSection).toContain("- review — 代码审查");
  });

  it("skills.disabled 命中的技能不产出工具与提示词段", async () => {
    const dir = makeSkill("review", "---\nname: review\ndescription: 代码审查\n---\n正文");
    const ext = await assembleSessionExtensions({ skills: { disabled: ["review"] } }, { projectSkillsDir: dir });
    expect(ext.tools).toEqual([]);
    expect(ext.promptSection).toBe("");
  });

  it("MCP server 并入工具（mcp__ 前缀）且管理器随装配返回", async () => {
    if (!serverFile) serverFile = writeFakeServer();
    const ext = await assembleSessionExtensions({ mcpServers: { fake: { command: process.execPath, args: [serverFile] } } });
    managers.push(ext.mcpManager!);
    expect(ext.tools.map((t) => t.name)).toContain("mcp__fake__echo");
    expect(ext.mcpErrors).toEqual([]);
    expect(ext.promptSection).toBe("");
  });

  it("启动失败的 server 跳过并产出错误行，不阻断装配", async () => {
    const ext = await assembleSessionExtensions({
      mcpServers: { bad: { command: "minicode-definitely-not-a-command-xyz" } },
    });
    expect(ext.tools).toEqual([]);
    expect(ext.mcpErrors).toHaveLength(1);
    expect(ext.mcpErrors[0]).toMatch(/^MCP 服务 bad 启动失败：/);
  });
});
