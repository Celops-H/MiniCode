/**
 * bash spawn 失败路径：mock node:child_process 让 spawn 返回「下一微任务抛 error 的假 child」，
 * 复现 shell 不可用等罕见场景，钉住结构化失败口径（isError + error 原因，供执行器补发失败事件）。
 */
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: spawnMock.spawn,
  spawnSync: vi.fn(),
}));

import { bashTool } from "../../src/tools/index.js";

/** 假的 child：error 处理器注册后抛启动错误；stdio 流挂事件即触发 close（settled 后无副作用） */
function mockSpawnFailure(message: string): void {
  const makeStream = () => {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        if (event === "close") queueMicrotask(() => handler());
        return this;
      },
      destroy() {},
    };
  };
  spawnMock.spawn.mockImplementation(() => {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    const child = {
      pid: undefined,
      stdin: { on: vi.fn(), end: vi.fn() },
      stdout: makeStream(),
      stderr: makeStream(),
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        if (event === "error") {
          queueMicrotask(() => {
            for (const h of handlers.get("error") ?? []) h(new Error(message));
          });
        }
        return child;
      },
    };
    return child;
  });
}

describe("bash 工具：spawn 失败（shell 不可用等）", () => {
  it("启动失败标记 isError 并携带失败原因（结构化失败信号，执行器据此补发 PostToolUseFailure）", async () => {
    mockSpawnFailure("spawn ENOENT");
    const out = await bashTool.execute({ command: "echo hi" });
    expect(out).toMatchObject({ isError: true, error: "命令启动失败：spawn ENOENT" });
    expect((out as { output: string }).output).toContain("命令启动失败：spawn ENOENT");
  });
});
