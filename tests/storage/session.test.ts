import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
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

  it("追加消息攒批后 flush 写 JSONL，重载后恢复全部消息", async () => {
    const store = setup();
    const session = await store.createSession({ model: "mock" });
    await store.appendMessage(session, userMessage("你好"));
    await store.appendMessage(session, assistantMessage([{ type: "text", text: "嗨" }]));
    await store.flush();

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

  it("listSessions 附每会话消息文件大小：空会话 0、有消息 >0", async () => {
    const store = setup();
    const empty = await store.createSession({ model: "m" }); // 无 jsonl，大小 0
    const a = await store.createSession({ model: "m" });
    await store.appendMessage(a, userMessage("一行消息"));
    await store.flush();

    const list = await store.listSessions();
    const byId = new Map(list.map((m) => [m.id, m]));
    expect(byId.get(a.meta.id)?.sizeBytes).toBeGreaterThan(0);
    expect(byId.get(empty.meta.id)?.sizeBytes).toBe(0);
  });

  it("deleteSession：删除消息与元数据文件，列表不再包含该会话", async () => {
    const store = setup();
    const a = await store.createSession({ model: "m" });
    const b = await store.createSession({ model: "m" });
    await store.appendMessage(a, userMessage("消息"));
    await store.flush();

    await store.deleteSession(a.meta.id);

    const list = await store.listSessions();
    expect(list.map((m) => m.id)).toEqual([b.meta.id]);
    await expect(store.loadSession(a.meta.id)).rejects.toThrow(); // 文件已移除
  });

  it("deleteSession：清理该会话未 flush 的攒批残留，后续 flush 不写回已删会话", async () => {
    const store = setup();
    const a = await store.createSession({ model: "m" });
    await store.appendMessage(a, userMessage("未落盘"));
    await store.deleteSession(a.meta.id); // 未 flush 即删：pending 中该会话消息一并丢弃
    await store.flush(); // 不报错、不写回已删会话

    const list = await store.listSessions();
    expect(list).toHaveLength(0);
  });

  it("deleteSession：删除不存在的会话幂等", async () => {
    const store = setup();
    await expect(store.deleteSession("not-exist")).resolves.toBeUndefined();
  });

  it("rewriteMessages：重写整份 JSONL，重载后与替换内容一致（/compact 用）", async () => {
    const store = setup();
    const session = await store.createSession({ model: "mock" });
    await store.appendMessage(session, userMessage("旧对话一"));
    await store.appendMessage(session, userMessage("旧对话二"));
    await store.flush();

    // 压缩替换：只留摘要消息
    const summary = userMessage("【会话摘要】压缩后的历史", "system");
    await store.rewriteMessages(session, [summary]);

    // 内存同步替换
    expect(session.getMessages()).toEqual([summary]);
    // 磁盘重写（临时文件原子替换，旧消息被覆盖）
    const loaded = await store.loadSession(session.meta.id);
    expect(loaded.getMessages()).toEqual([summary]);
  });

  it("rewriteMessages 清理攒批残留：重写前未 flush 的消息不污染重写后的盘（review 修复）", async () => {
    const store = setup();
    const session = await store.createSession({ model: "mock" });
    // 重写前 append 未 flush（攒批残留：重写前的旧消息）
    await store.appendMessage(session, userMessage("旧对话"));
    const summary = userMessage("【会话摘要】压缩后的历史", "system");
    await store.rewriteMessages(session, [summary]);
    // 此后 flush：不得把残留的旧消息追加到重写后的 JSONL
    await store.flush();

    const loaded = await store.loadSession(session.meta.id);
    expect(loaded.getMessages()).toEqual([summary]);
  });

  it("rewriteMessages 不误删重写期间并发追加的消息（真实并行，review 修复：快照过滤 vs 无条件删除的区分测试）", async () => {
    const store = setup();
    const session = await store.createSession({ model: "mock" });
    // 旧消息攒批未 flush
    await store.appendMessage(session, userMessage("旧对话"));
    const summary = userMessage("【会话摘要】压缩后的历史", "system");
    // 重写与追加并行：append 落在重写 IO 间隙（无条件删除会误删此消息，快照过滤保留）
    const rewriting = store.rewriteMessages(session, [summary]);
    await store.appendMessage(session, userMessage("新消息"));
    await rewriting;
    await store.flush();

    const loaded = await store.loadSession(session.meta.id);
    expect(loaded.getMessages()).toHaveLength(2);
    expect(loaded.getMessages()[0]).toEqual(summary);
    expect(loaded.getMessages()[1]?.content).toBe("新消息");
  });

  it("readJsonl 坏行跳过：单行损坏不拖垮整会话加载（review 修复，DESIGN 14 可修复）", async () => {
    const store = setup();
    const session = await store.createSession({ model: "mock" });
    await store.appendMessage(session, userMessage("好行"));
    await store.flush();
    // 在 JSONL 里混入损坏行（模拟写盘中断的半行）
    const file = path.join(dir, `${session.meta.id}.jsonl`);
    await appendFile(file, "{\"role\":\"user\",\"content\":\"半行中断\n", "utf8");

    const loaded = await store.loadSession(session.meta.id);
    // 好行仍在，坏行被跳过
    expect(loaded.getMessages()).toHaveLength(1);
    expect(loaded.getMessages()[0]?.content).toBe("好行");
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

  it("flush 幂等：meta 写失败后重试不重复追加消息", async () => {
    const store = setup();
    const session = await store.createSession({ model: "mock" });
    await store.appendMessage(session, userMessage("你好"));

    // 用同名目录占位 meta 文件，使 writeFile(meta) 失败
    const metaPath = path.join(dir, `${session.meta.id}.meta.json`);
    rmSync(metaPath);
    mkdirSync(metaPath);
    await expect(store.flush()).rejects.toThrow();

    // 消息已落盘且已从 pending 移除；重试 flush 不再重复追加
    await store.flush();
    const lines = (await readFile(path.join(dir, `${session.meta.id}.jsonl`), "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(1);
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
    await store.flush();

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
