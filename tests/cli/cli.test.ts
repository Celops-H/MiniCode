import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import { interact } from "../../src/cli/interact.js";
import { buildModelClient } from "../../src/cli/models.js";
import { SessionStore } from "../../src/storage/index.js";
import type { Tool } from "../../src/tools/index.js";

function mockTextClient(text: string): ModelClient {
  return {
    async *stream() {
      yield { type: "text_delta", text };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

describe("CLI 模型组装", () => {
  it("buildModelClient 注册默认 DeepSeek 模型", () => {
    const models = buildModelClient();
    expect(models.resolve("deepseek-chat")).toBeDefined();
  });

  it("可覆盖模型 id", () => {
    const models = buildModelClient(undefined, "qwen-plus");
    expect(models.resolve("qwen-plus")).toBeDefined();
  });
});

describe("CLI 交互循环", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("逐行输入 → Agent 回复 → 消息持久化", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    const agent = new Agent({
      modelClient: mockTextClient("回复内容"),
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
    });

    async function* inputs(): AsyncIterable<string> {
      yield "你好";
      yield "再见";
      yield "/exit";
    }

    const outputs: string[] = [];
    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: (text) => outputs.push(text),
    });

    expect(outputs.join("")).toContain("回复内容");
    // 两轮对话：user + assistant × 2
    const loaded = await store.loadSession(session.meta.id);
    expect(loaded.getMessages()).toHaveLength(4);
    expect(loaded.getMessages()[0]).toEqual({ role: "user", content: "你好" });
    expect(loaded.getMessages()[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "回复内容" }],
    });
  });

  it("/exit 退出交互，后续输入不再处理", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    const agent = new Agent({
      modelClient: mockTextClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
    });

    async function* inputs(): AsyncIterable<string> {
      yield "你好";
      yield "/exit";
      yield "再见"; // 不应被处理
    }

    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: () => {},
    });

    const loaded = await store.loadSession(session.meta.id);
    // 只有 "你好" 一轮，/exit 后不再处理
    expect(loaded.getMessages()).toHaveLength(2);
    expect(loaded.getMessages()[0]).toEqual({ role: "user", content: "你好" });
  });

  it("渲染思考、工具调用与工具结果", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    const readTool: Tool = {
      name: "read",
      description: "读取文件",
      inputSchema: z.object({ path: z.string() }),
      isReadOnly: true,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: () => "文件内容",
    };
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "thinking_delta", thinking: "分析中…" };
            yield { type: "toolcall_start", index: 0, id: "c1", name: "read" };
            yield { type: "toolcall_delta", index: 0, partialJson: '{"path":"a.ts"}' };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "已读取" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [readTool],
    });

    async function* inputs(): AsyncIterable<string> {
      yield "读文件";
      yield "/exit";
    }
    const outputs: string[] = [];
    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: (text) => outputs.push(text),
    });

    const out = outputs.join("");
    expect(out).toContain("分析中…"); // 思考渲染
    expect(out).toContain("[工具] read"); // 工具调用渲染
    expect(out).toContain("[工具结果] 文件内容"); // 工具结果渲染
  });

  it("渲染错误事件", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    const agent = new Agent({
      modelClient: {
        async *stream() {
          yield { type: "error", message: "流中断" };
          yield { type: "done", stopReason: "error" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
    });

    async function* inputs(): AsyncIterable<string> {
      yield "hi";
      yield "/exit";
    }
    const outputs: string[] = [];
    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: (text) => outputs.push(text),
    });

    expect(outputs.join("")).toContain("[错误] 流中断");
  });
});
