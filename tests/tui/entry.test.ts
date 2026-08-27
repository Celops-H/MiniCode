/**
 * 层 1：TUI 初始会话解析（P6-1/2）——启动不创建会话（内存草稿不落盘）、
 * minicode -c 继续最近活跃会话（listSessions 倒序首个）、无最近回落草稿。
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionStore } from "../../src/storage/index.js";
import { resolveInitialSession, reloadOrDraftSession } from "../../src/tui/index.js";

let dir = "";

function makeStore(): SessionStore {
  dir = mkdtempSync(path.join(os.tmpdir(), "minicode-entry-"));
  return new SessionStore(dir);
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it("无 sessionId/-c：构造内存草稿会话（新会话/模型传入），不落盘（目录无文件）", async () => {
  const store = makeStore();
  const session = await resolveInitialSession({}, store, "mock-model");
  expect(session.meta.title).toBe("新会话");
  expect(session.meta.model).toBe("mock-model");
  expect(session.getMessages()).toEqual([]);
  // 草稿不带 meta 文件：启动不开会走人不在 sessions 目录留空会话
  expect(readdirSync(dir)).toHaveLength(0);
});

it("sessionId：加载指定会话（minicode -c <id> 继续）", async () => {
  const store = makeStore();
  const created = await store.createSession({ model: "m1", title: "指定会话" });
  const session = await resolveInitialSession({ sessionId: created.meta.id }, store, "m2");
  expect(session.meta.id).toBe(created.meta.id);
  expect(session.meta.title).toBe("指定会话");
  expect(session.meta.model).toBe("m1"); // 会话自身模型优先于入口默认
});

it("continueRecent：继续最近活跃会话（listSessions 倒序首个）", async () => {
  const store = makeStore();
  await store.createSession({ model: "m1" });
  await new Promise((r) => setTimeout(r, 5));
  const latest = await store.createSession({ model: "m2", title: "最新会话" });
  const session = await resolveInitialSession({ continueRecent: true }, store, "m3");
  expect(session.meta.id).toBe(latest.meta.id);
  expect(session.meta.title).toBe("最新会话");
});

it("continueRecent 无历史会话：回落启动草稿态（不报错、不落盘）", async () => {
  const store = makeStore();
  const session = await resolveInitialSession({ continueRecent: true }, store, "mock-model");
  expect(session.meta.title).toBe("新会话");
  expect(readdirSync(dir)).toHaveLength(0);
});

it("sessionId 指向不存在的会话：报错（minicode -c <坏 id> 由入口层给可读提示）", async () => {
  const store = makeStore();
  await expect(resolveInitialSession({ sessionId: "nope" }, store, "m2")).rejects.toThrow();
});

it("sessionId 短前缀：命中唯一会话加载（面板显示哈希后 6 位，照抄即可续会话，P2）", async () => {
  const store = makeStore();
  const created = await store.createSession({ model: "m1", title: "目标会话" });
  const session = await resolveInitialSession({ sessionId: created.meta.id.slice(0, 6) }, store, "m2");
  expect(session.meta.id).toBe(created.meta.id);
  expect(session.meta.title).toBe("目标会话");
});

it("sessionId 短前缀撞多个会话：取最近活跃的一个", async () => {
  const store = makeStore();
  // 手工落两个同前缀的 meta 文件（前缀由 id 随机生成，无法经 createSession 指定）
  const writeMeta = (id: string, title: string, updatedAt: string): void => {
    writeFileSync(
      path.join(dir, `${id}.meta.json`),
      JSON.stringify({ id, title, model: "m1", createdAt: updatedAt, updatedAt, formatVersion: 1 }),
    );
  };
  const prefix = "ffff01";
  writeMeta(`${prefix}aaaa-old`, "旧会话", "2026-08-26T00:00:00.000Z");
  writeMeta(`${prefix}bbbb-new`, "新会话", "2026-08-27T00:00:00.000Z");
  const session = await resolveInitialSession({ sessionId: prefix }, store, "m2");
  expect(session.meta.title).toBe("新会话"); // listSessions 按更新时间倒序，撞前缀取首个
});

it("sessionId 短前缀无匹配：保持报错（不静默改草稿态）", async () => {
  const store = makeStore();
  const created = await store.createSession({ model: "m1", title: "存在" });
  await expect(
    resolveInitialSession({ sessionId: `${created.meta.id.slice(0, 4)}ffff` }, store, "m2"),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("reloadOrDraftSession：已落盘会话读盘续跑（含 /model 改过的模型）", async () => {
  const store = makeStore();
  const created = await store.createSession({ model: "m1", title: "已落盘" });
  const reloaded = await reloadOrDraftSession(store, created, "m3");
  expect(reloaded.meta.id).toBe(created.meta.id);
  expect(reloaded.meta.title).toBe("已落盘");
});

it("reloadOrDraftSession：草稿未落盘（ENOENT）重建草稿不报错", async () => {
  const store = makeStore();
  const draft = await resolveInitialSession({}, store, "m2");
  const reloaded = await reloadOrDraftSession(store, draft, "m2");
  expect(reloaded.meta.title).toBe("新会话");
  expect(reloaded.meta.model).toBe("m2");
  expect(readdirSync(dir)).toHaveLength(0); // 重建仍是草稿，不落盘
});

it("reloadOrDraftSession：非 ENOENT 读盘错误上抛（meta 损坏不静默吞数据，S-3）", async () => {
  const store = makeStore();
  const created = await store.createSession({ model: "m1", title: "损坏" });
  writeFileSync(path.join(dir, `${created.meta.id}.meta.json`), "{ 坏 json");
  await expect(reloadOrDraftSession(store, created, "m3")).rejects.toThrow();
});
