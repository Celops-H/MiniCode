import { describe, expect, it } from "vitest";
import { createContext, userMessage } from "../../src/core/index.js";
import type { StreamEvent } from "../../src/core/index.js";
import type { Protocol, Provider } from "../../src/llm/index.js";

async function* chunkGen(...vals: unknown[]): AsyncIterable<unknown> {
  for (const v of vals) yield v;
}

describe("Protocol 接口约定", () => {
  const mockProtocol: Protocol = {
    type: "openai-chat-completions",
    buildRequest(context) {
      return { messages: context.messages.map((m) => ({ role: m.role, content: m.content })) };
    },
    async *parseStream(stream) {
      for await (const chunk of stream) {
        yield { type: "text_delta", text: String(chunk) };
      }
      yield { type: "done", stopReason: "end_turn" };
    },
  };

  it("buildRequest 将 Context 转换为厂商请求体", () => {
    const req = mockProtocol.buildRequest(createContext("s", [userMessage("hi")]));
    expect(req).toEqual({ messages: [{ role: "user", content: "hi" }] });
  });

  it("parseStream 将厂商流式 chunk 转成统一事件流", async () => {
    const events: StreamEvent[] = [];
    for await (const e of mockProtocol.parseStream(chunkGen("a", "b"))) events.push(e);
    expect(events).toEqual([
      { type: "text_delta", text: "a" },
      { type: "text_delta", text: "b" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });
});

describe("Provider 接口约定", () => {
  const mockProvider: Provider = {
    id: "mock",
    name: "Mock",
    baseUrl: "http://localhost:8080",
    auth: { configured: true, source: "env" },
    getModels: () => [
      { id: "mock-1", name: "Mock 1", api: "openai-chat-completions", providerId: "mock" },
    ],
    async *stream() {
      yield { type: "text_delta", text: "ok" };
      yield { type: "done", stopReason: "end_turn" };
    },
  };

  it("getModels 返回模型列表", () => {
    expect(mockProvider.getModels()).toHaveLength(1);
    expect(mockProvider.getModels()[0]?.id).toBe("mock-1");
  });

  it("stream 返回统一事件流", async () => {
    const events: StreamEvent[] = [];
    for await (const e of mockProvider.stream("mock-1", createContext("s"))) events.push(e);
    expect(events).toEqual([
      { type: "text_delta", text: "ok" },
      { type: "done", stopReason: "end_turn" },
    ]);
  });
});
