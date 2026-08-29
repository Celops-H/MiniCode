import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGlobalConfigSeed } from "../../src/config/seed.js";
import { PROVIDER_PRESETS } from "../../src/config/presets.js";
import { configSchema } from "../../src/config/types.js";
import type { ConfigPaths } from "../../src/config/index.js";

const dirs: string[] = [];

function tempPaths(): ConfigPaths {
  const dir = mkdtempSync(path.join(os.tmpdir(), "minicode-seed-"));
  dirs.push(dir);
  return { globalConfigFile: path.join(dir, ".minicode", "config.json"), projectConfigFile: path.join(dir, "proj.json") };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("ensureGlobalConfigSeed（全局配置播种）", () => {
  it("文件不存在时按厂商预设写种子：只写 providers，逐条含 id/baseUrl/apiKeyEnv/models，过 strict schema", async () => {
    const paths = tempPaths();
    await ensureGlobalConfigSeed(paths);
    expect(existsSync(paths.globalConfigFile)).toBe(true);
    const raw = JSON.parse(readFileSync(paths.globalConfigFile, "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["providers"]);
    const providers = raw.providers as Array<Record<string, unknown>>;
    expect(providers.map((p) => p.id)).toEqual(PROVIDER_PRESETS.map((p) => p.id));
    for (const p of providers) {
      expect(typeof p.baseUrl).toBe("string");
      expect(typeof p.apiKeyEnv).toBe("string");
      expect(Array.isArray(p.models) && (p.models as unknown[]).length > 0).toBe(true);
      // key 不播种：只写环境变量名，不带 key 值
      expect(Object.keys(p).some((k) => /key/i.test(k) && k !== "apiKeyEnv")).toBe(false);
    }
    // 种子必须能过配置 schema（播种即合法，loadConfig 不因种子报错）
    expect(() => configSchema.parse(raw)).not.toThrow();
  });

  it("目录不存在时递归创建", async () => {
    const paths = tempPaths();
    expect(existsSync(path.dirname(paths.globalConfigFile))).toBe(false);
    await ensureGlobalConfigSeed(paths);
    expect(existsSync(paths.globalConfigFile)).toBe(true);
  });

  it("文件已存在时一个字节不动（用户手编内容绝对尊重）", async () => {
    const paths = tempPaths();
    mkdirSync(path.dirname(paths.globalConfigFile), { recursive: true });
    const handEdited = '{\n  "providers": [\n    { "id": "mine", "baseUrl": "https://x.example.com", "apiKeyEnv": "X", "models": [{ "id": "m" }] }\n  ],\n  "modelChain": ["m"]\n}\n';
    writeFileSync(paths.globalConfigFile, handEdited);
    await ensureGlobalConfigSeed(paths);
    expect(readFileSync(paths.globalConfigFile, "utf8")).toBe(handEdited);
  });

  it("并发双写只落一份（wx 独占冲突静默放行），内容仍是合法种子", async () => {
    const paths = tempPaths();
    await Promise.all([ensureGlobalConfigSeed(paths), ensureGlobalConfigSeed(paths)]);
    const raw = JSON.parse(readFileSync(paths.globalConfigFile, "utf8")) as Record<string, unknown>;
    expect((raw.providers as unknown[]).length).toBe(PROVIDER_PRESETS.length);
  });

  it("删除文件后重启按预设重建（重置出口）", async () => {
    const paths = tempPaths();
    mkdirSync(path.dirname(paths.globalConfigFile), { recursive: true });
    writeFileSync(paths.globalConfigFile, "{}\n");
    rmSync(paths.globalConfigFile);
    await ensureGlobalConfigSeed(paths);
    const raw = JSON.parse(readFileSync(paths.globalConfigFile, "utf8")) as Record<string, unknown>;
    expect((raw.providers as Array<Record<string, unknown>>).map((p) => p.id)).toEqual(
      PROVIDER_PRESETS.map((p) => p.id),
    );
  });
});

describe("播种跨平台权限（E32）", () => {
  it.runIf(process.platform !== "win32")("新建目录 0o700、配置文件 0o600（Windows 忽略 mode 跳过）", async () => {
    const paths = tempPaths();
    await ensureGlobalConfigSeed(paths);
    const { statSync } = await import("node:fs");
    const dirMode = statSync(path.dirname(paths.globalConfigFile)).mode & 0o777;
    const fileMode = statSync(paths.globalConfigFile).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("目录已存在：播种幂等不报错、内容不覆盖（跨平台行为一致）", async () => {
    const paths = tempPaths();
    mkdirSync(path.dirname(paths.globalConfigFile), { recursive: true });
    await ensureGlobalConfigSeed(paths);
    const before = readFileSync(paths.globalConfigFile, "utf8");
    await ensureGlobalConfigSeed(paths);
    expect(readFileSync(paths.globalConfigFile, "utf8")).toBe(before);
  });
});
