import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mapKey } from "../../src/tui/keymap.js";
import { buildSettingsRows, setSettingEnabled, SETTING_SPECS, settingValue } from "../../src/tui/settings.js";
import type { Config } from "../../src/config/index.js";

describe("buildSettingsRows（面板行构造）", () => {
  it("无配置时六项开关按缺省值展示（压缩/隔离/协作/轨迹开，记忆/调试关）", () => {
    const rows = buildSettingsRows(undefined);
    expect(rows.map((r) => r.id)).toEqual(SETTING_SPECS.map((s) => s.id));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.enabled]))).toEqual({
      "compact.enabled": true,
      memory: false,
      worktrees: true,
      agents: true,
      "observability.enabled": true,
      "debug.streamChunks": false,
    });
  });

  it("合并配置的生效值覆盖缺省值（嵌套与标量字段都读生效值）", () => {
    const config = {
      compact: { enabled: false },
      memory: true,
      agents: false,
      observability: { enabled: false },
      debug: { streamChunks: true },
    } as unknown as Config;
    const rows = buildSettingsRows(config);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.enabled]))).toEqual({
      "compact.enabled": false,
      memory: true,
      worktrees: true,
      agents: false,
      "observability.enabled": false,
      "debug.streamChunks": true,
    });
  });

  it("字段形状非布尔时回落缺省值（不把非法形状当开关值）", () => {
    const config = { agents: "off", compact: { enabled: 1 } } as unknown as Config;
    const rows = buildSettingsRows(config);
    expect(rows.find((r) => r.id === "agents")!.enabled).toBe(true);
    expect(rows.find((r) => r.id === "compact.enabled")!.enabled).toBe(true);
  });
});

describe("setSettingEnabled（写回定义层）", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 造双层配置环境：返回注入用的两个配置文件路径 */
  function setup(global?: Record<string, unknown>, project?: Record<string, unknown>) {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-settings-"));
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

  it("两层都未定义时写全局（新建文件），标量字段直接落键", async () => {
    const paths = setup();
    await setSettingEnabled("memory", true, paths);
    // 写回经 strict schema 校验，缺省项（logLevel）随之补齐（与 connect/扩展面板写盘一致）
    expect(read(paths.globalConfigFile)).toEqual({ logLevel: "info", memory: true });
    expect(existsSync(paths.projectConfigFile)).toBe(false);
  });

  it("项目层定义过的标量字段写项目层，全局同名字段不受影响", async () => {
    const paths = setup({ agents: true, logLevel: "debug" }, { agents: false });
    await setSettingEnabled("agents", true, paths);
    expect(read(paths.projectConfigFile)).toEqual({ logLevel: "info", agents: true });
    expect(read(paths.globalConfigFile)).toEqual({ agents: true, logLevel: "debug" });
  });

  it("项目层未定义、全局定义时写全局", async () => {
    const paths = setup({ memory: false });
    await setSettingEnabled("memory", true, paths);
    expect(read(paths.globalConfigFile)).toEqual({ logLevel: "info", memory: true });
    expect(existsSync(paths.projectConfigFile)).toBe(false);
  });

  it("嵌套字段按父对象判定定义层：父对象在项目层时写项目层（哪怕项目未写 enabled）", async () => {
    // 项目层定义了 compact（窗口参数覆盖），只写全局会被后级覆盖静默无效，必须写项目层
    const paths = setup({ compact: { contextWindow: 64000 } }, { compact: { contextWindow: 128000 } });
    await setSettingEnabled("compact.enabled", false, paths);
    // compact 的可缺省项按 schema 缺省值补齐（与装配层兜底一致）
    expect(read(paths.projectConfigFile).compact).toEqual({
      contextWindow: 128000,
      enabled: false,
      maxOutputTokens: 8192,
      safetyMargin: 4096,
      keepRecentToolResults: 5,
    });
    // 全局层的 compact 原样保留
    expect(read(paths.globalConfigFile).compact).toEqual({ contextWindow: 64000 });
  });

  it("嵌套字段父对象只在全局时写全局；两层都无时全局新建父对象", async () => {
    const paths = setup({ observability: { dir: "~/traces" } });
    await setSettingEnabled("observability.enabled", false, paths);
    expect(read(paths.globalConfigFile).observability).toEqual({ dir: "~/traces", enabled: false });

    await setSettingEnabled("debug.streamChunks", true, paths);
    expect(read(paths.globalConfigFile).debug).toEqual({ streamChunks: true });
  });

  it("同层其它键保留，写回经 strict schema 校验", async () => {
    const paths = setup({
      logLevel: "info",
      modelChain: ["deepseek-chat"],
      providers: [{ id: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", models: [{ id: "deepseek-chat" }] }],
    });
    await setSettingEnabled("worktrees", false, paths);
    const global = read(paths.globalConfigFile);
    expect(global.worktrees).toBe(false);
    expect(global.logLevel).toBe("info");
    expect(global.modelChain).toEqual(["deepseek-chat"]);
  });

  it("未知设置项抛错不落盘", async () => {
    const paths = setup();
    await expect(setSettingEnabled("hooks.SessionStart", true, paths)).rejects.toThrow("未知的设置项");
    expect(existsSync(paths.globalConfigFile)).toBe(false);
  });

  it("坏 JSON 配置文件抛错不静默重置", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-settings-"));
    const globalConfigFile = path.join(tmpDir, "bad", "config.json");
    const projectConfigFile = path.join(tmpDir, "bad", "project.json");
    mkdirSync(path.dirname(globalConfigFile), { recursive: true });
    writeFileSync(globalConfigFile, "{ not json");
    // 两层路径都注入隔离目录：不回落 resolveConfigPaths 的真实 cwd 配置
    await expect(setSettingEnabled("agents", false, { globalConfigFile, projectConfigFile })).rejects.toThrow();
    expect(readFileSync(globalConfigFile, "utf8")).toBe("{ not json");
  });
});

describe("mapKey（/settings 弹窗键位）", () => {
  const ctx = { popup: "modal" as const, modalKind: "settings" as const };
  it("↑↓ 导航、←→ 切开关、Enter 应用、Esc 取消（同扩展面板）", () => {
    expect(mapKey({ kind: "up" }, ctx)).toEqual({ type: "modal-nav", dir: -1 });
    expect(mapKey({ kind: "down" }, ctx)).toEqual({ type: "modal-nav", dir: 1 });
    expect(mapKey({ kind: "left" }, ctx)).toEqual({ type: "extensions-toggle" });
    expect(mapKey({ kind: "right" }, ctx)).toEqual({ type: "extensions-toggle" });
    expect(mapKey({ kind: "enter" }, ctx)).toEqual({ type: "modal-confirm" });
    expect(mapKey({ kind: "esc" }, ctx)).toEqual({ type: "cancel" });
  });
});
