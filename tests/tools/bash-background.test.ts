import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bashTool,
  getBackgroundTask,
  killAllBackgroundTasks,
  killBackgroundTask,
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

  it("多字节字符恰在 chunk 边界被劈开时输出不乱码（E91，StringDecoder 按流解码）", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bg-utf8-"));
    const script = path.join(dir, "split.mjs");
    // 先写「你」的前 2 个字节（劈开多字节字符），50ms 后补完——旧实现按段 toString
    // 会产出 U+FFFD
    writeFileSync(
      script,
      [
        "const full = Buffer.from('你好世界', 'utf8');",
        "process.stdout.write(full.subarray(0, 2));",
        "setTimeout(() => process.stdout.write(full.subarray(2)), 50);",
      ].join("\n"),
      "utf8",
    );
    const out = await bashTool.execute({ command: `node "${script}"`, background: true });
    const id = /任务 (b\d+)/.exec(out as string)?.[1]!;
    await vi.waitFor(
      () => {
        expect(getBackgroundTask(id)?.status).toBe("completed");
      },
      { timeout: 5000 },
    );
    expect(getBackgroundTask(id)?.output).toContain("你好世界");
    expect(getBackgroundTask(id)?.output).not.toContain("�");
    rmSync(dir, { recursive: true, force: true });
  });

  it("killBackgroundTask 对已完成任务不覆盖状态（E92：真实退出码不丢）", async () => {
    const out = await bashTool.execute({
      command: "node -e \"process.exit(3)\"",
      background: true,
    });
    const id = /任务 (b\d+)/.exec(out as string)?.[1]!;
    await vi.waitFor(
      () => {
        expect(getBackgroundTask(id)?.status).toBe("failed");
      },
      { timeout: 5000 },
    );
    const before = getBackgroundTask(id);
    const result = killBackgroundTask(id!);
    // 已 failed 的任务不被标记 killed，退出码保留
    expect(result?.status).toBe("failed");
    expect(result?.exitCode).toBe(3);
    expect(before?.status).toBe("failed");
  });

  it("后台任务 spawn 后立即关闭 stdin（E92）：等待输入的命令读到 EOF 即退出", async () => {
    // findstr（Windows）/ cat（POSIX）无文件参数时读 stdin 直到 EOF：
    // stdin 未关闭会永挂占任务位，关闭后读到 EOF 立即退出
    const out = await bashTool.execute({
      command: process.platform === "win32" ? "findstr x" : "cat",
      background: true,
    });
    const id = /任务 (b\d+)/.exec(out as string)?.[1]!;
    await vi.waitFor(
      () => {
        const status = getBackgroundTask(id)?.status;
        expect(status === "completed" || status === "failed").toBe(true);
      },
      { timeout: 5000 },
    );
  });

  it("后台命令不判定为只读并发安全", () => {
    expect(bashTool.isConcurrencySafe!({ command: "echo hi", background: true })).toBe(false);
    expect(bashTool.isConcurrencySafe!({ command: "echo hi" })).toBe(true);
  });
});