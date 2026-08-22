import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bashTool,
  getBackgroundTask,
  killAllBackgroundTasks,
} from "../../src/tools/index.js";

afterEach(() => {
  killAllBackgroundTasks();
});

describe("bash 后台执行", () => {
  it("background 启动后台任务，立即返回任务 id，命令跑完状态为 completed", async () => {
    const out = await bashTool.execute({
      command: "node -e \"console.log('background-ok')\"",
      background: true,
    });
    expect(out).toContain("已后台启动（任务");
    const id = /任务 (b\d+)/.exec(out as string)?.[1];
    expect(id).toBeTruthy();

    await vi.waitFor(
      () => {
        expect(getBackgroundTask(id!)?.status).toBe("completed");
      },
      { timeout: 5000 },
    );
    expect(getBackgroundTask(id!)?.output).toContain("background-ok");
    expect(getBackgroundTask(id!)?.exitCode).toBe(0);
  });

  it("后台命令失败时状态为 failed 并记录非零退出码", async () => {
    const out = await bashTool.execute({
      command: "node -e \"process.exit(3)\"",
      background: true,
    });
    const id = /任务 (b\d+)/.exec(out as string)?.[1];

    await vi.waitFor(
      () => {
        expect(getBackgroundTask(id!)?.status).toBe("failed");
      },
      { timeout: 5000 },
    );
    expect(getBackgroundTask(id!)?.exitCode).toBe(3);
  });

  it("killBackgroundTask 终止后台进程并标记 killed", async () => {
    const out = await bashTool.execute({
      command: "node -e \"setInterval(() => {}, 1000)\"",
      background: true,
    });
    const id = /任务 (b\d+)/.exec(out as string)?.[1];

    const killed = getBackgroundTask(id!);
    expect(killed?.status).toBe("running");

    killAllBackgroundTasks();
    await vi.waitFor(
      () => {
        expect(getBackgroundTask(id!)?.status).toBe("killed");
      },
      { timeout: 5000 },
    );
  });

  it("后台命令不判定为只读并发安全", () => {
    expect(bashTool.isConcurrencySafe!({ command: "echo hi", background: true })).toBe(false);
    expect(bashTool.isConcurrencySafe!({ command: "echo hi" })).toBe(true);
  });
});