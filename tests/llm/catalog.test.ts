/**
 * models.dev 模型目录：缓存 → 快照分层加载、损坏缓存回落、过期后台刷新。
 * 测试注入临时路径与假 fetch，不触真实网络。
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { lookupModelLimits, setCatalogDeps } from "../../src/llm/catalog.js";

const SNAPSHOT = {
  deepseek: { models: { "deepseek-v4-flash": { limit: { context: 1_000_000, output: 393_216 } } } },
  openai: { models: { "gpt-4o": { limit: { context: 128_000, output: 16_384 } }, "gpt-x": {} } },
  broken: { models: { "m": { limit: { context: "200k" } } } },
};

let dir: string;
let cacheFile: string;
let snapshotFile: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mc-catalog-"));
  cacheFile = path.join(dir, "cache", "models-dev.json");
  snapshotFile = path.join(dir, "snapshot.json");
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await writeFile(snapshotFile, JSON.stringify(SNAPSHOT), "utf8");
});

/** 与 tests/setup.ts 一致的测试级默认依赖（afterEach 恢复用，避免落回真实网络默认） */
function resetToTestDefaults(): void {
  setCatalogDeps({
    cacheFile: path.join(os.tmpdir(), `minicode-test-catalog-${process.pid}.json`),
    snapshotFile: fileURLToPath(new URL("../../src/llm/models-dev.json", import.meta.url)),
    fetchImpl: () => Promise.reject(new Error("测试进程不发真实目录请求")),
  });
}

afterEach(async () => {
  resetToTestDefaults();
  await rm(dir, { recursive: true, force: true });
});

function depsWith(overrides: {
  fetchImpl?: typeof fetch;
  now?: () => number;
}): void {
  setCatalogDeps({
    cacheFile,
    snapshotFile,
    fetchImpl: overrides.fetchImpl ?? (() => Promise.reject(new Error("不应发起请求"))),
    now: overrides.now ?? (() => 1_000_000_000_000),
    refreshIntervalMs: 24 * 60 * 60 * 1000,
  });
}

it("无缓存时回落内置快照，按 provider+model 查窗口与输出上限", () => {
  depsWith({});
  expect(lookupModelLimits("deepseek", "deepseek-v4-flash")).toEqual({
    contextWindow: 1_000_000,
    maxTokens: 393_216,
  });
  expect(lookupModelLimits("openai", "gpt-4o")).toEqual({ contextWindow: 128_000, maxTokens: 16_384 });
});

it("查不到的厂商/模型返回 undefined；limit 无有效数值同样返回 undefined", () => {
  depsWith({});
  expect(lookupModelLimits("unknown", "m")).toBeUndefined();
  expect(lookupModelLimits("openai", "gpt-x")).toBeUndefined();
  expect(lookupModelLimits("broken", "m")).toBeUndefined();
});

it("有缓存文件时优先用缓存，且缓存新鲜（mtime 在期内）不发起刷新", async () => {
  await writeFile(cacheFile, JSON.stringify({ fresh: { models: { m: { limit: { context: 5 } } } } }), "utf8");
  depsWith({ now: () => Date.now() }); // mtime 即现在，必然新鲜
  expect(lookupModelLimits("fresh", "m")).toEqual({ contextWindow: 5 });
  expect(lookupModelLimits("deepseek", "deepseek-v4-flash")).toBeUndefined();
});

it("缓存损坏：删除坏文件、回落快照", async () => {
  await writeFile(cacheFile, "{ 半截 JSON", "utf8");
  depsWith({});
  expect(lookupModelLimits("deepseek", "deepseek-v4-flash")).toEqual({
    contextWindow: 1_000_000,
    maxTokens: 393_216,
  });
  expect(existsSync(cacheFile)).toBe(false);
});

it("缓存过期（mtime 超期）：后台刷新拉新写缓存，下一次查找热加载新值", async () => {
  await writeFile(cacheFile, JSON.stringify({ stale: { models: { m: { limit: { context: 1 } } } } }), "utf8");
  // mtime 是文件创建时刻（过去），now 取远未来 → 过期；刷新后把时钟拨回，缓存转新鲜
  let fetchCalled = 0;
  let clockOffsetMs = 10 * 24 * 60 * 60 * 1000;
  const fresh = { fresh: { models: { m: { limit: { context: 9 } } } } };
  depsWith({
    now: () => Date.now() + clockOffsetMs,
    fetchImpl: (async () => {
      fetchCalled++;
      return new Response(JSON.stringify(fresh), { status: 200 });
    }) as typeof fetch,
  });
  // 本轮用已加载的旧缓存
  expect(lookupModelLimits("stale", "m")).toEqual({ contextWindow: 1 });
  // 刷新在后台跑：轮到事件循环后已落盘
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fetchCalled).toBe(1);
  expect(existsSync(`${cacheFile}.${process.pid}.tmp`)).toBe(false);
  clockOffsetMs = 0;
  // 下一次查找核对 mtime 热加载：新值生效（长驻进程的多次装配间吃到刷新数据）
  expect(lookupModelLimits("fresh", "m")).toEqual({ contextWindow: 9 });
  expect(lookupModelLimits("stale", "m")).toBeUndefined();
  // 缓存已新鲜：不再重复发起刷新
  expect(fetchCalled).toBe(1);
});

it("刷新失败静默：旧数据照常可用", async () => {
  await writeFile(cacheFile, JSON.stringify({ stale: { models: { m: { limit: { context: 1 } } } } }), "utf8");
  depsWith({
    now: () => Date.now() + 10 * 24 * 60 * 60 * 1000,
    fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
  });
  expect(lookupModelLimits("stale", "m")).toEqual({ contextWindow: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(lookupModelLimits("stale", "m")).toEqual({ contextWindow: 1 });
});
