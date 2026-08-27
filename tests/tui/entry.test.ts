/**
 * 层 1：TUI 初始会话解析（P6-1/2）——启动不创建会话（内存草稿不落盘）、
 * minicode -c 继续最近活跃会话（listSessions 倒序首个）、无最近回落草稿。
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionStore } from "../../src/storage/index.js";
import { resolveInitialSession } from "../../src/tui/index.js";

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
