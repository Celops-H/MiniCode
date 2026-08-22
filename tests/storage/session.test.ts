import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import { assistantMessage, userMessage } from "../../src/core/index.js";
import { SessionStore, type SessionMeta } from "../../src/storage/index.js";

function mockTextClient(text: string): ModelClient {
  return {
    async *stream() {
      yield { type: "text_delta", text };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

describe("会话持久化与续跑", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(): SessionStore {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-session-"));
    return new SessionStore(dir);
  }

  it("新建会话落盘元数据并可加载", async () => {
    const store = setup();
    const session = await store.createSession({ model: "deepseek-chat", title: "测试会话" });

    expect(session.meta.id).toBeTruthy();
    expect(session.meta.model).toBe("deepseek-chat");

    const loaded = await store.loadSession(session.meta.id);
    expect(loaded.meta).toEqual(session.meta);
    expect(loaded.getMessages()).toEqual([]);
  });

  it("存储目录不存在时自动创建", async () => {
    // 直接指向一个尚不存在的嵌套目录
    const base = mkdtempSync(path.join(os.tmpdir(), "minicode-nested-"));
    const nestedDir = path.join(base, "deep", "nested");
    const store = new SessionStore(nestedDir);
    const session = await store.createSession({ model: "mock" });

    const loaded = await store.loadSession(session.meta.id);
    expect(loaded.meta.id).toBe(session.meta.id);
  });

  it("追加消息写 JSONL，重载后恢复全部消息", async () => {
    const store = setup();
    const session = await store.createSession({ model: "mock" });
    await store.appendMessage(session, userMessage("你好"));
    await store.appendMessage(session, assistantMessage([{ type: "text", text: "嗨" }]));

    const loaded = await store.loadSession(session.meta.id);
    expect(loaded.getMessages()).toHaveLength(2);
    expect(loaded.getMessages()[0]).toEqual({ role: "user", id: expect.any(String), content: "你好" });
    expect(loaded.getMessages()[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "嗨" }],
    });
  });

  it("listSessions 按更新时间倒序列出", async () => {
    const store = setup();
    const a = await store.createSession({ model: "m" });
    const b = await store.createSession({ model: "m" });
    await store.appendMessage(a, userMessage("较早"));
    await store.flush(); // updatedAt 延迟落盘，flush 后列表排序才反映最新

    const list = await store.listSessions();
    expect(list.map((m) => m.id)).toEqual([a.meta.id, b.meta.id]);
  });

  it("meta 延迟写：append 只改内存，flush 落盘", async () => {
    const store = setup();
    const session = await store.createSession({ model: "mock" });
    await new Promise((r) => setTimeout(r, 5)); // 保证 append 的 updatedAt 与创建时不同毫秒
    await store.appendMessage(session, userMessage("你好"));

    const onDiskBefore = JSON.parse(
      await readFile(path.join(dir, `${session.meta.id}.meta.json`), "utf8"),
    ) as SessionMeta;
    expect(onDiskBefore.updatedAt).not.toBe(session.meta.updatedAt); // 未 flush，盘上仍是创建时时间

    await store.flush();
    const onDiskAfter = JSON.parse(
      await readFile(path.join(dir, `${session.meta.id}.meta.json`), "utf8"),
    ) as SessionMeta;
    expect(onDiskAfter.updatedAt).toBe(session.meta.updatedAt); // flush 后落盘
  });

  it("会话元数据带格式版本号，旧会话缺失时视为 1", async () => {
    const store = setup();
    const session = await store.createSession({ model: "mock" });
    expect(session.meta.formatVersion).toBe(1);

    // 模拟旧格式会话：meta 文件无 formatVersion，加载后补 1
    const legacyMeta = {
      id: "legacy",
      title: "旧会话",
      model: "mock",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(
      path.join(dir, "legacy.meta.json"),
      JSON.stringify(legacyMeta, null, 2),
      "utf8",
    );
    const loaded = await store.loadSession("legacy");
    expect(loaded.meta.formatVersion).toBe(1);
  });

  it("续跑：加载会话历史，Agent 继续对话", async () => {
    const store = setup();
    const session = await store.createSession({ model: "mock" });
    await store.appendMessage(session, userMessage("第一问"));

    // 从持久化历史重建会话
    const loaded = await store.loadSession(session.meta.id);
    const agent = new Agent({
      modelClient: mockTextClient("这是历史之后的回复"),
      modelId: "mock",
      systemPrompt: "助手",
      initialMessages: loaded.getMessages(),
    });
    agent.start("第二问");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const messages = agent.getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: "user", id: expect.any(String), content: "第一问" }); // 历史
    expect(messages[1]).toEqual({ role: "user", id: expect.any(String), content: "第二问" });
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "这是历史之后的回复" }],
    });
  });
});
