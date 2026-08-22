import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import { SessionStore } from "../../src/storage/index.js";
import { createBuiltinTools } from "../../src/tools/index.js";

/**
 * 端到端冒烟测试：mock 模型 + 真实文件工具，验证 M1 核心闭环。
 * 不依赖真实 API，用脚本化模型流驱动一次「读文件 → 回灌 → 继续」的完整链路。
 */
describe("M1 端到端冒烟", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("完整链路：用户提问 → 模型调工具 → 真实执行 → 结果回灌 → 模型总结", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-e2e-"));
    const file = path.join(dir, "data.txt");
    writeFileSync(file, "答案：42");

    // 脚本化模型：首轮请求 read 工具，拿到结果后总结
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        const hasToolResult = context.messages.some((m) => m.role === "tool_result");
        if (!hasToolResult) {
          yield { type: "toolcall_start", index: 0, id: "call_1", name: "read" };
          yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ path: file }) };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
        } else {
          // 模型看到工具结果后总结
          const result = context.messages.find((m) => m.role === "tool_result");
          yield { type: "text_delta", text: `文件内容是：${(result as { content: string }).content.trim()}` };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };

    const agent = new Agent({
      modelClient,
      modelId: "mock",
      systemPrompt: "你是助手",
      tools: createBuiltinTools(),
    });
    agent.start("读一下 data.txt 的内容");
    const outputs: string[] = [];
    for await (const event of agent.run()) {
      if (event.type === "text_delta") outputs.push(event.text);
    }

    // 模型总结里应包含真实读到的文件内容
    expect(outputs.join("")).toContain("答案：42");

    // 消息链：user → assistant(工具调用) → tool_result → assistant(总结)
    const messages = agent.getMessages();
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool_result",
      "assistant",
    ]);
    expect(messages[2]).toMatchObject({ role: "tool_result", toolCallId: "call_1", isError: false });
  });

  it("完整链路可持久化并续跑", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-e2e-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });

    // 第一段：工具回合
    const file = path.join(dir, "x.txt");
    writeFileSync(file, "hello");
    const agent = new Agent({
      modelClient: {
        async *stream(_m, ctx) {
          if (!ctx.messages.some((m) => m.role === "tool_result")) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "read" };
            yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ path: file }) };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "读完" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: createBuiltinTools(),
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费
    }
    for (const m of agent.getMessages()) {
      await store.appendMessage(session, m);
    }
    await store.flush();

    // 续跑：从持久化历史重建
    const loaded = await store.loadSession(session.meta.id);
    expect(loaded.getMessages().map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool_result",
      "assistant",
    ]);
  });
});
