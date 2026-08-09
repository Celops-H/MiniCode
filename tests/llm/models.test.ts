import { describe, expect, it } from "vitest";
import { createContext } from "../../src/core/index.js";
import type { StreamEvent } from "../../src/core/index.js";
import { Models } from "../../src/llm/index.js";
import type { Provider, ModelInfo } from "../../src/llm/index.js";

function makeProvider(id: string, modelIds: string[], reply: string): Provider {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com`,
    auth: { configured: true },
    getModels: () =>
      modelIds.map(
        (mid): ModelInfo => ({ id: mid, name: mid, api: "openai-chat-completions", providerId: id }),
      ),
    async *stream(modelId) {
      yield { type: "text_delta", text: `${reply}:${modelId}` };
      yield { type: "done", stopReason: "stop" };
    },
  };
}

describe("Models 集合", () => {
  it("register 后可按 provider id 查找", () => {
    const models = new Models();
    models.register(makeProvider("a", ["a-1"], "A"));
    expect(models.provider("a")?.id).toBe("a");
    expect(models.provider("missing")).toBeUndefined();
  });

  it("listModels 汇总全部 Provider 的模型", () => {
    const models = new Models();
    models.register(makeProvider("a", ["a-1", "a-2"], "A"));
    models.register(makeProvider("b", ["b-1"], "B"));
    expect(models.listModels().map((m) => m.id)).toEqual(["a-1", "a-2", "b-1"]);
  });

  it("resolve 根据模型 id 定位 Provider", () => {
    const models = new Models();
    models.register(makeProvider("a", ["a-1"], "A"));
    models.register(makeProvider("b", ["b-1"], "B"));
    expect(models.resolve("b-1")?.provider.id).toBe("b");
    expect(models.resolve("nope")).toBeUndefined();
  });

  it("stream 路由到对应 Provider", async () => {
    const models = new Models();
    models.register(makeProvider("a", ["a-1"], "A"));
    models.register(makeProvider("b", ["b-1"], "B"));
    const events: StreamEvent[] = [];
    for await (const e of models.stream("b-1", createContext("s"))) events.push(e);
    expect(events).toEqual([
      { type: "text_delta", text: "B:b-1" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("未知模型抛错", async () => {
    const models = new Models();
    models.register(makeProvider("a", ["a-1"], "A"));
    const gen = models.stream("unknown", createContext("s"));
    await expect(async () => {
      for await (const _ of gen) {
        // 消费流以触发路由错误
      }
    }).rejects.toThrow("未知模型");
  });
});
