import { describe, expect, it, vi } from "vitest";
import { HookBus } from "../../src/hooks/index.js";
import type { HookEvent, HookVerdict } from "../../src/hooks/index.js";

describe("HookBus 事件总线", () => {
  it("on 注册后 emit 触发，处理器收到事件负载", async () => {
    const bus = new HookBus();
    const handler = vi.fn();
    bus.on("UserPromptSubmit", handler);
    await bus.emit({ type: "UserPromptSubmit", input: "你好" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: "UserPromptSubmit", input: "你好" });
  });

  it("退订后不再触发", async () => {
    const bus = new HookBus();
    const handler = vi.fn();
    const unsubscribe = bus.on("Stop", handler);
    unsubscribe();
    await bus.emit({ type: "Stop" });

    expect(handler).not.toHaveBeenCalled();
  });

  it("多个处理器按注册顺序执行，支持异步", async () => {
    const bus = new HookBus();
    const order: string[] = [];
    bus.on("PreToolUse", async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("first");
    });
    bus.on("PreToolUse", () => {
      order.push("second");
    });
    await bus.emit({ type: "PreToolUse", toolCallId: "t1", toolName: "bash", input: {} });

    expect(order).toEqual(["first", "second"]);
  });

  it("emit 返回各处理器结果（PreToolUse 裁决）", async () => {
    const bus = new HookBus();
    bus.on("PreToolUse", (): HookVerdict => "ask");
    bus.on("PreToolUse", (): HookVerdict => "deny");
    const results = await bus.emit({ type: "PreToolUse", toolCallId: "t1", toolName: "bash", input: {} });

    expect(results).toEqual(["ask", "deny"]);
  });

  it("观测型处理器返回 void 不影响 emit", async () => {
    const bus = new HookBus();
    bus.on("SessionStart", () => {});
    const results = await bus.emit({ type: "SessionStart" });

    expect(results).toEqual([undefined]);
  });

  it("按事件类型独立分发，无处理器时返回空数组", async () => {
    const bus = new HookBus();
    const handler = vi.fn();
    bus.on("PostToolUse", handler);
    const results = await bus.emit({ type: "SessionEnd" });

    expect(handler).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("处理器抛错时向上抛出", async () => {
    const bus = new HookBus();
    bus.on("Stop", () => {
      throw new Error("hook 失败");
    });
    await expect(bus.emit({ type: "Stop" })).rejects.toThrow("hook 失败");
  });

  it("事件负载类型可收窄（PreToolUse 带工具信息）", async () => {
    const bus = new HookBus();
    const received: HookEvent[] = [];
    bus.on("PreToolUse", (event) => {
      received.push(event);
    });
    await bus.emit({ type: "PreToolUse", toolCallId: "t1", toolName: "read", input: { path: "a.ts" } });

    expect(received[0]).toMatchObject({ type: "PreToolUse", toolCallId: "t1", toolName: "read", input: { path: "a.ts" } });
  });
});