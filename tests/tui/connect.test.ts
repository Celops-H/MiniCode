/**
 * /connect 写配置逻辑测试：全局 config 合并 provider（不写 modelChain——模型归 /model 管）+ .env 幂等追加/替换。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { connectProvider, writeGlobalConfig, writeEnvKey, fetchProviderModels, PROVIDER_PRESETS, type ProviderPreset } from "../../src/tui/connect.js";

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

it("writeGlobalConfig：Anthropic 协议预设写入 protocol 字段，OpenAI 预设不写", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-connect-"));
  const file = path.join(dir, "config.json");
  try {
    const anthropicPreset = PROVIDER_PRESETS.find((p) => p.id === "zhipu-coding")!;
    await writeGlobalConfig(file, anthropicPreset);
    const parsed = JSON.parse(await readFile(file, "utf8")) as { providers: Array<{ id: string; protocol?: string }> };
    expect(parsed.providers[0]).toMatchObject({ id: "zhipu-coding", protocol: "anthropic-messages" });

    const file2 = path.join(dir, "config2.json");
    await writeGlobalConfig(file2, deepseek);
    const parsed2 = JSON.parse(await readFile(file2, "utf8")) as { providers: Array<{ id: string; protocol?: string }> };
    expect(parsed2.providers[0]?.id).toBe("deepseek");
    expect(parsed2.providers[0]?.protocol).toBeUndefined();
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

it("connectProvider：anthropic 协议预设跳过 /models 拉取，直接写预设占位模型", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-connect-"));
  const globalFile = path.join(dir, "config.json");
  const envFile = path.join(dir, ".env");
  try {
    let fetchCalls = 0;
    const anthropicPreset = PROVIDER_PRESETS.find((p) => p.id === "deepseek-anthropic")!;
    const ok = await connectProvider(anthropicPreset, "sk-123", {
      globalConfigFile: globalFile,
      envFile,
      fetchImpl: async () => {
        fetchCalls++;
        return ["should-not-be-used"];
      },
    });
    expect(ok).toEqual({ ok: true });
    expect(fetchCalls).toBe(0);
    const config = JSON.parse(await readFile(globalFile, "utf8")) as {
      providers: Array<{ id: string; protocol?: string; models: { id: string }[] }>;
    };
    expect(config.providers[0]).toMatchObject({ id: "deepseek-anthropic", protocol: "anthropic-messages" });
    expect(config.providers[0]?.models.map((m) => m.id)).toEqual(anthropicPreset.models);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** /models 拉取 mock：返回给定列表；rejected 用于模拟 key 无效/网络失败 */
function fakeFetch(models: string[] | Error): typeof import("../../src/tui/connect.js").fetchProviderModels {
  return async () => {
    if (models instanceof Error) throw models;
    return models;
  };
}

it("connectProvider：写全局 config + .env 成功；空 key 拒绝", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-connect-"));
  const globalFile = path.join(dir, "config.json");
  const envFile = path.join(dir, ".env");
  try {
    // 注入空结果 mock：不真实请求网络（连接链路本身不再依赖 /models 成功）
    const ok = await connectProvider(deepseek, "sk-123", { globalConfigFile: globalFile, envFile, fetchImpl: async () => [] });
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

it("connectProvider 拉全量模型：/models 返回的列表替换预设占位写入配置（N1）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-connect-"));
  const globalFile = path.join(dir, "config.json");
  try {
    const result = await connectProvider(deepseek, "sk-123", {
      globalConfigFile: globalFile,
      envFile: path.join(dir, ".env"),
      fetchImpl: fakeFetch(["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash"]),
    });
    expect(result.ok).toBe(true);
    expect(result.fetchedModels).toBe(3);
    const config = JSON.parse(await readFile(globalFile, "utf8")) as { providers: { models: { id: string }[] }[] };
    expect(config.providers[0]?.models.map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("connectProvider 拉取失败（key 无效/网络）：用预设模型兜底、连接照常成功", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-connect-"));
  const globalFile = path.join(dir, "config.json");
  try {
    const result = await connectProvider(deepseek, "bad-key", {
      globalConfigFile: globalFile,
      envFile: path.join(dir, ".env"),
      fetchImpl: fakeFetch(new Error("HTTP 401")),
    });
    expect(result.ok).toBe(true);
    expect(result.fetchedModels).toBeUndefined();
    const config = JSON.parse(await readFile(globalFile, "utf8")) as { providers: { models: { id: string }[] }[] };
    // 回落预设占位模型
    expect(config.providers[0]?.models.map((m) => m.id)).toEqual(deepseek.models);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("fetchProviderModels：解析 OpenAI 兼容 {data:[{id}]}、过滤空 id、baseUrl 尾斜杠归一", async () => {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, headers: init?.headers });
    void init?.signal; // 超时信号由 AbortSignal.timeout 注入，此处不做时钟断言
    return new Response(JSON.stringify({ data: [{ id: "m-a" }, {}, { id: "m-b" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const list = await fetchProviderModels("https://example.com/api/v1/", "sk-x");
    expect(list).toEqual(["m-a", "m-b"]);
    expect(calls[0]?.url).toBe("https://example.com/api/v1/models");
    expect(calls[0]?.headers?.Authorization).toBe("Bearer sk-x");
  } finally {
    globalThis.fetch = origFetch;
  }
});

it("opencode 预设拆 Go/Zen 两端点（域名实测 zen/v1 与 zen/go/v1）", () => {
  const zen = PROVIDER_PRESETS.find((p) => p.id === "opencode-zen");
  const go = PROVIDER_PRESETS.find((p) => p.id === "opencode-go");
  expect(zen?.baseUrl).toBe("https://opencode.ai/zen/v1");
  expect(go?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
  expect(zen?.apiKeyEnv).toBe("OPENCODE_API_KEY");
  expect(go?.apiKeyEnv).toBe("OPENCODE_API_KEY");
});