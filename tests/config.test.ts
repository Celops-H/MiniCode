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
  it("按启动工作目录分子目录（E46）：路径中非字母数字字符替换为「-」", () => {
    const cwd = path.resolve(path.join(os.tmpdir(), "my proj", "app-v2"));
    const dir = resolveSessionsDir({ homedir: "/home/tester", cwd });
    expect(dir).toBe(
      path.join("/home/tester", ".minicode", "sessions", cwd.replace(/[^a-zA-Z0-9]/g, "-")),
    );
  });

  it("root 覆盖（config.sessionsDir）作用于根目录，子目录编码不变", () => {
    const cwd = path.resolve(path.join(os.tmpdir(), "w"));
    const dir = resolveSessionsDir({ homedir: "/home/tester", root: "/custom/sessions", cwd });
    expect(dir).toBe(path.join("/custom/sessions", cwd.replace(/[^a-zA-Z0-9]/g, "-")));
  });

  it("XDG_CONFIG_HOME 优先于 homedir", () => {
    const cwd = path.resolve(path.join(os.tmpdir(), "w"));
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    expect(resolveSessionsDir({ homedir: "/home/tester", xdgConfigHome: "/etc/xdg", cwd })).toBe(
      path.join("/etc/xdg", "minicode", "sessions", encoded),
    );
  });

  it("超长路径截断到 200 字符并追加内容哈希后缀（防截断撞名）", () => {
    const deep = path.resolve(`/${"x".repeat(300)}`);
    const dir = resolveSessionsDir({ homedir: "/home/tester", cwd: deep });
    const name = dir.split(path.sep).pop()!;
    expect(name.length).toBeLessThanOrEqual(200 + 1 + 7);
    expect(name).toMatch(/-[0-9a-z]+$/);
    // 内容不同的长路径哈希不同
    const other = resolveSessionsDir({ homedir: "/home/tester", cwd: path.resolve(`/${"y".repeat(300)}`) });
    expect(other.split(path.sep).pop()).not.toBe(name);
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

  it("拼错字段直接报错（strict，不默认忽略）", async () => {
    await expect(
      loadConfig({ paths: setup({ global: { loglevel: "debug" } }) }),
    ).rejects.toThrow();
  });

  it("嵌套对象同样 strict：provider/models 拼错字段直接报错", async () => {
    await expect(
      loadConfig({
        paths: setup({
          global: {
            providers: [
              {
                id: "deepseek",
                baseUrl: "https://api.deepseek.com",
                apiKeyEnv: "DEEPSEEK_API_KEY",
                models: [{ id: "deepseek-chat" }],
                unknownField: 1,
              },
            ],
          },
        }),
      }),
    ).rejects.toThrow();
    await expect(
      loadConfig({
        paths: setup({
          global: {
            providers: [
              {
                id: "deepseek",
                baseUrl: "https://api.deepseek.com",
                apiKeyEnv: "DEEPSEEK_API_KEY",
                models: [{ id: "deepseek-chat", contextWidow: 64000 }], // 拼错
              },
            ],
          },
        }),
      }),
    ).rejects.toThrow();
  });

  it("protocol 合法值放行、未知协议 strict 直接报错", async () => {
    const config = await loadConfig({
      paths: setup({
        global: {
          providers: [
            {
              id: "zhipu-anthropic",
              baseUrl: "https://open.bigmodel.cn/api/anthropic",
              apiKeyEnv: "ZHIPU_API_KEY",
              protocol: "anthropic-messages",
              models: [{ id: "glm-4-plus" }],
            },
          ],
        },
      }),
    });
    expect(config.providers?.[0]?.protocol).toBe("anthropic-messages");
    await expect(
      loadConfig({
        paths: setup({
          global: {
            providers: [
              {
                id: "x",
                baseUrl: "https://x.example.com",
                apiKeyEnv: "X",
                protocol: "gemini", // 未接入装配的协议不开放配置
                models: [{ id: "m" }],
              },
            ],
          },
        }),
      }),
    ).rejects.toThrow();
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

  it("providers 按 id 合并：全局与项目不同供应商都保留", async () => {
    const config = await loadConfig({
      paths: setup({
        global: { providers: [{ id: "a", baseUrl: "https://a.example.com", apiKeyEnv: "A", models: [{ id: "a-1" }] }] },
        project: { providers: [{ id: "b", baseUrl: "https://b.example.com", apiKeyEnv: "B", models: [{ id: "b-1" }] }] },
      }),
    });
    expect(config.providers?.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("providers 同 id：项目覆盖全局同供应商的配置（合并后不重复）", async () => {
    const config = await loadConfig({
      paths: setup({
        global: { providers: [{ id: "a", baseUrl: "https://a.example.com", apiKeyEnv: "A", models: [{ id: "a-1" }] }] },
        project: { providers: [{ id: "a", baseUrl: "https://a.example.com", apiKeyEnv: "A", models: [{ id: "a-2" }] }] },
      }),
    });
    expect(config.providers).toHaveLength(1);
    expect(config.providers?.[0]?.models).toEqual([{ id: "a-2" }]);
  });

  it("任一层 providers 非法（非数组/项缺 id）整体透传，schema 校验报错不静默吞", async () => {
    await expect(
      loadConfig({ paths: setup({ global: { providers: "oops" } }) }),
    ).rejects.toThrow();
    await expect(
      loadConfig({
        paths: setup({
          project: {
            providers: [
              { id: "a", baseUrl: "https://a.example.com", apiKeyEnv: "A", models: [] },
              { baseUrl: "https://b.example.com", apiKeyEnv: "B", models: [] }, // 缺 id
            ],
          },
        }),
      }),
    ).rejects.toThrow();
  });

  it("非法 providers 配置（baseUrl 非 URL）直接报错", async () => {
    await expect(
      loadConfig({
        paths: setup({ global: { providers: [{ id: "x", baseUrl: "not-a-url", apiKeyEnv: "X", models: [] }] } }),
      }),
    ).rejects.toThrow();
  });

  it("mcpServers 按服务名归并：全局与项目不同服务都保留", async () => {
    const config = await loadConfig({
      paths: setup({
        global: { mcpServers: { fs: { command: "npx", args: ["-y", "@a/fs"] } } },
        project: { mcpServers: { git: { command: "npx", args: ["-y", "@b/git"] } } },
      }),
    });
    expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual(["fs", "git"]);
  });

  it("mcpServers 同服务名：项目覆盖全局整个条目（合并不重复）", async () => {
    const config = await loadConfig({
      paths: setup({
        global: { mcpServers: { fs: { command: "npx", args: ["-y", "@a/fs"], env: { A: "1" } } } },
        project: { mcpServers: { fs: { command: "node", enabled: false } } },
      }),
    });
    // 整条覆盖语义同 providers：项目条目缺的 env 不从全局继承
    expect(config.mcpServers).toEqual({ fs: { command: "node", enabled: false } });
  });

  it("任一层 mcpServers 非法（非对象/条目非对象）整体透传，schema 校验报错不静默吞", async () => {
    await expect(loadConfig({ paths: setup({ global: { mcpServers: "oops" } }) })).rejects.toThrow();
    await expect(
      loadConfig({ paths: setup({ global: { mcpServers: { fs: "not-an-object" } } }) }),
    ).rejects.toThrow();
  });

  it("mcpServers 条目拼错字段直接报错（strict）", async () => {
    await expect(
      loadConfig({ paths: setup({ global: { mcpServers: { fs: { command: "npx", cmds: [] } } } }) }),
    ).rejects.toThrow();
  });

  it("skills.disabled 全局与项目名单取并集", async () => {
    const config = await loadConfig({
      paths: setup({
        global: { skills: { disabled: ["a", "b"] } },
        project: { skills: { disabled: ["b", "c"] } },
      }),
    });
    expect(config.skills?.disabled?.sort()).toEqual(["a", "b", "c"]);
  });

  it("任一层 skills 非法（disabled 非数组/元素非字符串/skills 非对象）整体透传，schema 校验报错", async () => {
    await expect(loadConfig({ paths: setup({ global: { skills: { disabled: "oops" } } }) })).rejects.toThrow();
    await expect(loadConfig({ paths: setup({ global: { skills: { disabled: [1, 2] } } }) })).rejects.toThrow();
    await expect(loadConfig({ paths: setup({ global: { skills: "oops" } }) })).rejects.toThrow();
  });

  it("skills 合法 disabled 与拼错键共存时整层透传报错（拼错键不静默丢弃）", async () => {
    await expect(
      loadConfig({ paths: setup({ global: { skills: { disabled: ["a"], diabeld: ["b"] } } }) }),
    ).rejects.toThrow();
  });

  it("skills 拼错字段直接报错（strict）", async () => {
    await expect(loadConfig({ paths: setup({ global: { skills: { enabled: true } } }) })).rejects.toThrow();
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
