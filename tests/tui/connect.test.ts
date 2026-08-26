/**
 * /connect 写配置逻辑测试：全局 config 合并 provider（不写 modelChain——模型归 /model 管）+ .env 幂等追加/替换。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { connectProvider, writeGlobalConfig, writeEnvKey, PROVIDER_PRESETS, type ProviderPreset } from "../../src/tui/connect.js";

const deepseek = PROVIDER_PRESETS.find((p) => p.id === "deepseek")!;
const qwen = PROVIDER_PRESETS.find((p) => p.id === "qwen")!;

it("writeGlobalConfig：写入 provider，不写 modelChain（模型切换归 /model 命令）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-connect-"));
  const file = path.join(dir, "config.json");
  try {
    await writeGlobalConfig(file, deepseek);
    const parsed = JSON.parse(await readFile(file, "utf8")) as { providers: unknown[]; modelChain?: string[] };
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0]).toMatchObject({ id: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" });
    // 连接只把供应商加进列表，不改优先级链——当前会话与模型保持（用 /model 切模型）
    expect(parsed.modelChain).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("writeGlobalConfig：重复连接同厂商不产生重复 provider（按 id 替换）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-connect-"));
  const file = path.join(dir, "config.json");
  try {
    await writeGlobalConfig(file, deepseek);
    await writeGlobalConfig(file, deepseek);
    await writeGlobalConfig(file, qwen);
    const parsed = JSON.parse(await readFile(file, "utf8")) as { providers: { id: string }[]; modelChain?: string[] };
    expect(parsed.providers).toHaveLength(2);
    expect(parsed.providers.map((p) => p.id)).toEqual(["deepseek", "qwen"]);
    // 始终不写 modelChain
    expect(parsed.modelChain).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("writeEnvKey：新增追加、更新替换（幂等）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-env-"));
  const env = path.join(dir, ".env");
  try {
    await writeEnvKey(env, "DEEPSEEK_API_KEY", "sk-first");
    expect(await readFile(env, "utf8")).toContain("DEEPSEEK_API_KEY=sk-first");
    await writeEnvKey(env, "DEEPSEEK_API_KEY", "sk-second");
    const text = await readFile(env, "utf8");
    expect(text).toContain("DEEPSEEK_API_KEY=sk-second");
    expect(text.split("DEEPSEEK_API_KEY=").length - 1).toBe(1); // 只有一行
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("connectProvider：写全局 config + .env 成功；空 key 拒绝", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-connect-"));
  const globalFile = path.join(dir, "config.json");
  const envFile = path.join(dir, ".env");
  try {
    const ok = await connectProvider(deepseek, "sk-123", { globalConfigFile: globalFile, envFile });
    expect(ok).toEqual({ ok: true });
    const config = JSON.parse(await readFile(globalFile, "utf8")) as { providers: { id: string }[] };
    expect(config.providers[0]?.id).toBe("deepseek");
    expect(await readFile(envFile, "utf8")).toContain("DEEPSEEK_API_KEY=sk-123");
    // 空 key
    const bad = await connectProvider(deepseek, "   ", { globalConfigFile: globalFile, envFile });
    expect(bad.ok).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});