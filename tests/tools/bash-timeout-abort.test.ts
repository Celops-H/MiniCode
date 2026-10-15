/**
 * bash 超时与用户打断同时成立时的判定口径：超时定时器先到点置 timedOut，随后用户按 Esc
 * 透传 abort 置 aborted，结算时打断分支排在超时之前——结果按打断呈现，只标 isError
 * 不带失败原因（主动行为不算失败），执行器据此不补发 PostToolUseFailure。
 * 真实进程难稳定造出「超时先到、打断后到」的时序，这里 mock spawn 拿挂起子进程，
 * 用假定时器精确推进超时点，再依次补「打断 / 退出 / 管道关闭」三件事。
 */
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: spawnMock.spawn,
  spawnSync: vi.fn(),
}));

import { bashTool } from "../../src/tools/index.js";

/** 假的挂起子进程：stdout/stderr 常开不关，exit 与流关闭由测试显式触发 */
function mockHangingChild(): { exit: () => void; closeStreams: () => void } {
  const closeable: (() => void)[] = [];
  const makeStream = () => {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    const api = {
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return api;
      },
      destroy() {},
    };
    closeable.push(() => {
      for (const h of handlers.get("close") ?? []) h();
    });
    return api;
  };
  const childHandlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const child = {
    pid: undefined,
    stdin: { on: vi.fn(), end: vi.fn() },
    stdout: makeStream(),
    stderr: makeStream(),
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = childHandlers.get(event) ?? [];
      list.push(handler);
      childHandlers.set(event, list);
      return child;
    },
  };
  spawnMock.spawn.mockImplementation(() => child);
  return {
    exit: () => {
      for (const h of childHandlers.get("exit") ?? []) h(null);
    },
    closeStreams: () => {
      for (const close of closeable) close();
    },
  };
}

describe("bash 工具：超时与打断同时成立", () => {
  it("以打断为准：带打断文案、不带失败原因（执行器据此不补发失败事件）", async () => {
    vi.useFakeTimers();
    try {
      const io = mockHangingChild();
      const controller = new AbortController();
      const promise = bashTool.execute(
        { command: "hang", timeoutMs: 200 },
        { signal: controller.signal },
      );
      // 超时先到点：timedOut 置位并触发杀进程
      await vi.advanceTimersByTimeAsync(200);
      // 用户随后打断：aborted 也置位
      controller.abort();
      // 进程退出 + 管道关闭，结算
      io.exit();
      io.closeStreams();

      const result = await promise;
      expect(result).toMatchObject({ isError: true });
      expect((result as { error?: string }).error).toBeUndefined();
      expect(String(JSON.stringify(result))).toContain("已被用户打断");
    } finally {
      vi.useRealTimers();
    }
  });
});
