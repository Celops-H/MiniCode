import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveConfigPaths, resolveSessionsDir } from "../src/config/index.js";
import type { ConfigPaths } from "../src/config/index.js";

describe("resolveConfigPaths", () => {
  it("用 homedir 与 cwd 解析全局与项目配置路径", () => {
    const paths = resolveConfigPaths({ homedir: "/home/tester", cwd: "/work/proj" });
    expect(paths.globalConfigFile).toBe(path.join("/home/tester", ".minicode", "config.json"));
    expect(paths.projectConfigFile).toBe(path.join("/work/proj", ".minicode.json"));
  });

  it("XDG_CONFIG_HOME 优先于 homedir", () => {
    const paths = resolveConfigPaths({ homedir: "/home/tester", xdgConfigHome: "/etc/xdg" });
    expect(paths.globalConfigFile).toBe(path.join("/etc/xdg", "minicode", "config.json"));
  });
});

describe("resolveSessionsDir", () => {
  it("默认解析到用户级 ~/.minicode/sessions，不随启动目录变化", () => {
    expect(resolveSessionsDir({ homedir: "/home/tester" })).toBe(
      path.join("/home/tester", ".minicode", "sessions"),
    );
  });

  it("XDG_CONFIG_HOME 优先于 homedir", () => {
    expect(resolveSessionsDir({ homedir: "/home/tester", xdgConfigHome: "/etc/xdg" })).toBe(
      path.join("/etc/xdg", "minicode", "sessions"),
    );
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 在临时目录构造配置来源，返回对应的 ConfigPaths */
  function setup(
    opts: { global?: Record<string, unknown>; project?: Record<string, unknown> } = {},
  ): ConfigPaths {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-test-"));
    const globalFile = path.join(tmpDir, "home", ".minicode", "config.json");
    const projectFile = path.join(tmpDir, "proj", ".minicode.json");
    if (opts.global) {
      mkdirSync(path.dirname(globalFile), { recursive: true });
      writeFileSync(globalFile, JSON.stringify(opts.global));
    }
    if (opts.project) {
      mkdirSync(path.dirname(projectFile), { recursive: true });
      writeFileSync(projectFile, JSON.stringify(opts.project));
    }
    return { globalConfigFile: globalFile, projectConfigFile: projectFile };
  }

  it("无任何配置时使用默认值", async () => {
    const config = await loadConfig({ paths: setup() });
    expect(config.logLevel).toBe("info");
  });

  it("全局配置生效", async () => {
    const config = await loadConfig({ paths: setup({ global: { logLevel: "debug" } }) });
    expect(config.logLevel).toBe("debug");
  });

  it("项目配置覆盖全局配置", async () => {
    const config = await loadConfig({
      paths: setup({ global: { logLevel: "debug" }, project: { logLevel: "warn" } }),
    });
    expect(config.logLevel).toBe("warn");
  });

  it("环境变量覆盖项目配置", async () => {
    const config = await loadConfig({
      paths: setup({ project: { logLevel: "warn" } }),
      env: { MINICODE_LOG_LEVEL: "error" },
    });
    expect(config.logLevel).toBe("error");
  });

  it("非 MINICODE_ 前缀的环境变量被忽略", async () => {
    const config = await loadConfig({
      paths: setup({ global: { logLevel: "debug" } }),
      env: { PATH: "/usr/bin", HOME: "/root" },
    });
    expect(config.logLevel).toBe("debug");
  });

  it("非法配置值直接报错", async () => {
    await expect(
      loadConfig({ paths: setup({ global: { logLevel: "bogus" } }) }),
    ).rejects.toThrow();
  });

  it("配置文件内容非 JSON 对象时报错", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-test-"));
    const globalFile = path.join(tmpDir, "home", ".minicode", "config.json");
    mkdirSync(path.dirname(globalFile), { recursive: true });
    writeFileSync(globalFile, "[1, 2, 3]");
    const paths = {
      globalConfigFile: globalFile,
      projectConfigFile: path.join(tmpDir, "proj", ".minicode.json"),
    };
    await expect(loadConfig({ paths })).rejects.toThrow();
  });

  it("全局配置提供模型 providers 与优先级链", async () => {
    const config = await loadConfig({
      paths: setup({
        global: {
          providers: [
            {
              id: "deepseek",
              baseUrl: "https://api.deepseek.com",
              apiKeyEnv: "DEEPSEEK_API_KEY",
              models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
            },
          ],
          modelChain: ["deepseek-chat", "deepseek-reasoner"],
        },
      }),
    });
    expect(config.providers).toEqual([
      {
        id: "deepseek",
        baseUrl: "https://api.deepseek.com",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
      },
    ]);
    expect(config.modelChain).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });

  it("项目配置覆盖全局配置的 providers", async () => {
    const config = await loadConfig({
      paths: setup({
        global: { providers: [{ id: "a", baseUrl: "https://a.example.com", apiKeyEnv: "A", models: [{ id: "a-1" }] }] },
        project: { providers: [{ id: "b", baseUrl: "https://b.example.com", apiKeyEnv: "B", models: [{ id: "b-1" }] }] },
      }),
    });
    expect(config.providers).toEqual([{ id: "b", baseUrl: "https://b.example.com", apiKeyEnv: "B", models: [{ id: "b-1" }] }]);
  });

  it("非法 providers 配置（baseUrl 非 URL）直接报错", async () => {
    await expect(
      loadConfig({
        paths: setup({ global: { providers: [{ id: "x", baseUrl: "not-a-url", apiKeyEnv: "X", models: [] }] } }),
      }),
    ).rejects.toThrow();
  });

  it("全局配置提供会话目录", async () => {
    const config = await loadConfig({ paths: setup({ global: { sessionsDir: "/custom/sessions" } }) });
    expect(config.sessionsDir).toBe("/custom/sessions");
  });

  it("环境变量 MINICODE_SESSIONS_DIR 覆盖会话目录", async () => {
    const config = await loadConfig({
      paths: setup({ project: { sessionsDir: "/proj/sessions" } }),
      env: { MINICODE_SESSIONS_DIR: "/env/sessions" },
    });
    expect(config.sessionsDir).toBe("/env/sessions");
  });
});
