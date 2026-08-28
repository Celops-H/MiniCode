import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mapKey } from "../../src/tui/keymap.js";
import { buildMcpRows, buildSkillRows, diffExtensionRows, setMcpServerEnabled, setSkillDisabled } from "../../src/tui/extensions.js";
import type { McpServerStatus } from "../../src/mcp/index.js";
import type { SkillInfo } from "../../src/skills/index.js";

describe("buildMcpRows / buildSkillRows（面板行构造）", () => {
  it("mcp 行按 enabled 与装配状态合并出状态列", () => {
    const servers = {
      fs: { command: "npx" },
      git: { command: "npx", enabled: false },
      bad: { command: "nope" },
    };
    const statuses: McpServerStatus[] = [
      { name: "fs", enabled: true, started: true, toolCount: 2 },
      { name: "bad", enabled: true, started: false, toolCount: 0, error: "握手超时（initialize，10000ms）" },
    ];
    const rows = buildMcpRows(servers, statuses);
    expect(rows.map((r) => r.id)).toEqual(["fs", "git", "bad"]);
    expect(rows[0]).toMatchObject({ enabled: true, detail: "已连接 · 2 个工具" });
    expect(rows[1]).toMatchObject({ enabled: false, detail: "未启动" });
    // 失败原因截断到 60 字符防面板爆行
    expect(rows[2]!.detail).toBe("启动失败：握手超时（initialize，10000ms）");
  });

  it("skill 行按 disabled 名单标启用态并带来源层", () => {
    const skills: SkillInfo[] = [
      { name: "review", description: "审查代码", source: "project", filePath: "/p/review/SKILL.md" },
      { name: "deploy", description: "部署", source: "user", filePath: "/u/deploy/SKILL.md" },
    ];
    const rows = buildSkillRows(skills, ["deploy"]);
    expect(rows[0]).toMatchObject({ enabled: true, source: "project", detail: "审查代码" });
    expect(rows[1]).toMatchObject({ enabled: false, source: "user", detail: "部署" });
  });
});

describe("setMcpServerEnabled / setSkillDisabled（写回定义层）", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 造双层配置环境：返回注入用的两个配置文件路径 */
  function setup(global?: Record<string, unknown>, project?: Record<string, unknown>) {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-ext-"));
    const globalConfigFile = path.join(tmpDir, "home", ".minicode", "config.json");
    const projectConfigFile = path.join(tmpDir, "proj", ".minicode.json");
    if (global) {
      mkdirSync(path.dirname(globalConfigFile), { recursive: true });
      writeFileSync(globalConfigFile, JSON.stringify(global));
    }
    if (project) {
      mkdirSync(path.dirname(projectConfigFile), { recursive: true });
      writeFileSync(projectConfigFile, JSON.stringify(project));
    }
    return { globalConfigFile, projectConfigFile };
  }

  const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8"));

  it("全局定义的服务写回全局文件，不产生项目配置", async () => {
    const paths = setup({ mcpServers: { fs: { command: "npx", args: ["-y", "fs"] } } });
    await setMcpServerEnabled("fs", false, paths);
    const global = read(paths.globalConfigFile);
    expect(global.mcpServers).toEqual({ fs: { command: "npx", args: ["-y", "fs"], enabled: false } });
    expect(existsSync(paths.projectConfigFile)).toBe(false);
  });

  it("项目定义的服务写回项目文件，全局同名字段不受影响", async () => {
    const paths = setup({ mcpServers: { fs: { command: "npx" } } });
    // 项目层重定义 fs（覆盖语义：整条生效）——写回应落项目层，全局原样
    mkdirSync(path.dirname(paths.projectConfigFile), { recursive: true });
    writeFileSync(paths.projectConfigFile, JSON.stringify({ mcpServers: { fs: { command: "node" } } }));
    await setMcpServerEnabled("fs", false, paths);
    expect(read(paths.projectConfigFile).mcpServers).toEqual({ fs: { command: "node", enabled: false } });
    expect(read(paths.globalConfigFile).mcpServers).toEqual({ fs: { command: "npx" } });
  });

  it("同层其它服务与顶层键保留；两层都没有的服务抛错", async () => {
    const paths = setup({
      logLevel: "debug",
      mcpServers: { fs: { command: "npx" }, git: { command: "npx", enabled: false } },
    });
    await setMcpServerEnabled("fs", false, paths);
    const global = read(paths.globalConfigFile);
    expect(global.logLevel).toBe("debug");
    expect(global.mcpServers).toEqual({
      fs: { command: "npx", enabled: false },
      git: { command: "npx", enabled: false },
    });
    await expect(setMcpServerEnabled("nope", true, paths)).rejects.toThrow("未找到 MCP 服务 nope");
  });

  it("技能回写按来源落层：项目技能写项目配置、用户技能写全局配置，启用即移出名单", async () => {
    const paths = setup({ skills: { disabled: ["old"] } });
    await setSkillDisabled("review", true, "project", paths);
    expect(read(paths.projectConfigFile).skills).toEqual({ disabled: ["review"] });
    // 全局层的名单不受项目技能影响
    expect(read(paths.globalConfigFile).skills).toEqual({ disabled: ["old"] });

    await setSkillDisabled("deploy", true, "user", paths);
    expect(read(paths.globalConfigFile).skills).toEqual({ disabled: ["old", "deploy"] });

    // 启用 = 从名单移出；重复关闭不重复加入
    await setSkillDisabled("review", false, "project", paths);
    await setSkillDisabled("deploy", true, "user", paths);
    expect(read(paths.projectConfigFile).skills).toEqual({ disabled: [] });
    expect(read(paths.globalConfigFile).skills).toEqual({ disabled: ["old", "deploy"] });
  });

  it("启用操作清两层名单（任一层旧标记都会让启用无效，跨层关闭场景）", async () => {
    // 用户层技能被项目名单关闭（团队共享配置的典型场景）；全局文件不存在
    const paths = setup(undefined, { skills: { disabled: ["deploy"] } });
    await setSkillDisabled("deploy", false, "user", paths);
    expect(read(paths.projectConfigFile).skills).toEqual({ disabled: [] });
    // 全局文件原本不存在：启用操作不创建文件（名单里本就没有它）
    expect(existsSync(paths.globalConfigFile)).toBe(false);

    // 反向：项目技能被全局名单关闭，启用同样清两层
    const paths2 = setup({ skills: { disabled: ["review"] } });
    await setSkillDisabled("review", false, "project", paths2);
    expect(read(paths2.globalConfigFile).skills).toEqual({ disabled: [] });
  });

  it("目标文件不存在时新建（用户技能关闭且全局配置缺文件）", async () => {
    const paths = setup();
    await setSkillDisabled("deploy", true, "user", paths);
    expect(existsSync(paths.globalConfigFile)).toBe(true);
    expect(read(paths.globalConfigFile).skills).toEqual({ disabled: ["deploy"] });
  });

  it("skills.disabled 形状非法（非数组）时抛错不静默重写", async () => {
    const paths = setup({ skills: { disabled: "oops" } });
    await expect(setSkillDisabled("deploy", true, "user", paths)).rejects.toThrow("skills.disabled 配置非法");
    // 抛错即不落盘：原样保留
    expect(read(paths.globalConfigFile).skills).toEqual({ disabled: "oops" });
  });

  it("坏 JSON 配置文件抛错不静默重置", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-ext-"));
    const globalConfigFile = path.join(tmpDir, "bad", "config.json");
    mkdirSync(path.dirname(globalConfigFile), { recursive: true });
    writeFileSync(globalConfigFile, "{ not json");
    await expect(setSkillDisabled("a", true, "user", { globalConfigFile })).rejects.toThrow();
    expect(readFileSync(globalConfigFile, "utf8")).toBe("{ not json");
  });

  it("diffExtensionRows：按 id 比对启用态出改动行，基线外的新行不算改动", () => {
    const baseline = [
      { id: "a", enabled: true },
      { id: "b", enabled: false },
    ];
    const rows = [
      { id: "a", label: "a", detail: "", enabled: true },
      { id: "b", label: "b", detail: "", enabled: true },
      { id: "new", label: "new", detail: "", enabled: true },
    ];
    expect(diffExtensionRows(baseline, rows).map((r) => r.id)).toEqual(["b"]);
  });
});

describe("mapKey（/mcp /skill 弹窗键位）", () => {
  const ctx = { popup: "modal" as const, modalKind: "mcp" as const };
  it("↑↓ 导航、←→ 切启用、Enter 应用、Esc 取消", () => {
    expect(mapKey({ kind: "up" }, ctx)).toEqual({ type: "modal-nav", dir: -1 });
    expect(mapKey({ kind: "down" }, ctx)).toEqual({ type: "modal-nav", dir: 1 });
    expect(mapKey({ kind: "left" }, ctx)).toEqual({ type: "extensions-toggle" });
    expect(mapKey({ kind: "right" }, ctx)).toEqual({ type: "extensions-toggle" });
    expect(mapKey({ kind: "enter" }, ctx)).toEqual({ type: "modal-confirm" });
    expect(mapKey({ kind: "esc" }, ctx)).toEqual({ type: "cancel" });
  });
  it("/skill 弹窗同键位", () => {
    const skillCtx = { popup: "modal" as const, modalKind: "skill" as const };
    expect(mapKey({ kind: "right" }, skillCtx)).toEqual({ type: "extensions-toggle" });
    expect(mapKey({ kind: "enter" }, skillCtx)).toEqual({ type: "modal-confirm" });
  });
});
