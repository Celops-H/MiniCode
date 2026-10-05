import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  bashTaskTool,
  bashTool,
  getBackgroundTask,
  killAllBackgroundTasks,
  startBackgroundTask,
} from "../../src/tools/index.js";
import type { BackgroundTask } from "../../src/tools/index.js";
import { taskStateText } from "../../src/tools/builtin/bash-task.js";

// 起真实 shell/node 子进程，后台任务轮询受整机负载影响大：
// 按自身耗时设独立超时，不用全局默认 5s，避免高负载下被误报为功能回归
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  killAllBackgroundTasks();
});

describe("bash_task 工具", () => {
  it("bash 描述写明默认超时与 timeoutMs 参数", () => {
    expect(bashTool.description).toContain("30 秒");
    expect(bashTool.description).toContain("timeoutMs");
    expect(bashTool.description).toContain("background");
  });

  it("status 查询已完成任务，返回状态与新增输出", async () => {
    const out = await bashTool.execute({
      command: "node -e \"console.log('bg-done')\"",
      background: true,
    });
    const id = /任务 (b\d+)/.exec(out as string)?.[1];
    await vi.waitFor(
      () => {
        expect(getBackgroundTask(id!)?.status).toBe("completed");
      },
      { timeout: 5000 },
    );

    const res = await bashTaskTool.execute({ task_id: id!, action: "status" });
    expect(res).toContain("已完成");
    expect(res).toContain("bg-done");
    expect(res).toContain("新增输出");
  });

  it("status 连续查询：只返回自上次查询以来的新增输出", async () => {
    const out = await bashTool.execute({
      command: "node -e \"console.log('first'); setTimeout(() => console.log('second'), 800)\"",
      background: true,
    });
    const id = /任务 (b\d+)/.exec(out as string)?.[1];
    await vi.waitFor(
      () => {
        expect(getBackgroundTask(id!)?.output).toContain("first");
      },
      { timeout: 5000 },
    );

    // 首查：拿到已有输出
    const first = await bashTaskTool.execute({ task_id: id!, action: "status" });
    expect(first).toContain("first");
    expect(first).toContain("运行中");

    // 二查（尚无新输出）：明确标注无新增，模型不再把旧输出当进展反复轮询
    const second = await bashTaskTool.execute({ task_id: id!, action: "status" });
    expect(second).toContain("运行中");
    expect(second).toContain("无新增输出");
    expect(second).not.toContain("first");
    expect(second).not.toContain("second");

    // 三查（新输出到达后）：只回新增的 second
    await vi.waitFor(
      () => {
        expect(getBackgroundTask(id!)?.status).toBe("completed");
      },
      { timeout: 5000 },
    );
    const third = await bashTaskTool.execute({ task_id: id!, action: "status" });
    expect(third).toContain("second");
    expect(third).toContain("新增输出");

    // 四查（终态后再查）：明确告知任务已结束，无需再查询
    const fourth = await bashTaskTool.execute({ task_id: id!, action: "status" });
    expect(fourth).toContain("已完成");
    expect(fourth).toContain("无需再查询");
    expect(fourth).not.toContain("second");
  });

  it("kill 后再查 status：返回剩余新增输出与已终止状态", async () => {
    const out = await bashTool.execute({
      command: "node -e \"console.log('before-kill'); setInterval(() => {}, 1000)\"",
      background: true,
    });
    const id = /任务 (b\d+)/.exec(out as string)?.[1];
    await vi.waitFor(
      () => {
        expect(getBackgroundTask(id!)?.output).toContain("before-kill");
      },
      { timeout: 5000 },
    );

    // kill 前未查询过：终止后首查仍能拿到 kill 前的输出
    await bashTaskTool.execute({ task_id: id!, action: "kill" });
    await vi.waitFor(
      () => {
        expect(getBackgroundTask(id!)?.status).toBe("killed");
      },
      { timeout: 5000 },
    );
    const res = await bashTaskTool.execute({ task_id: id!, action: "status" });
    expect(res).toContain("已终止");
    expect(res).toContain("before-kill");
    expect(res).toContain("新增输出");
  });

  it("status 查询运行中任务，返回运行状态", async () => {
    const out = await bashTool.execute({
      command: "node -e \"setInterval(() => {}, 1000)\"",
      background: true,
    });
    const id = /任务 (b\d+)/.exec(out as string)?.[1];

    const res = await bashTaskTool.execute({ task_id: id!, action: "status" });
    expect(res).toContain("运行中");
  });

  it("kill 终止后台任务并标记 killed", async () => {
    const out = await bashTool.execute({
      command: "node -e \"setInterval(() => {}, 1000)\"",
      background: true,
    });
    const id = /任务 (b\d+)/.exec(out as string)?.[1];

    const res = await bashTaskTool.execute({ task_id: id!, action: "kill" });
    expect(res).toContain("已终止");
    await vi.waitFor(
      () => {
        expect(getBackgroundTask(id!)?.status).toBe("killed");
      },
      { timeout: 5000 },
    );
  });

  it("查询不存在的任务返回提示", async () => {
    const res = await bashTaskTool.execute({ task_id: "b999", action: "status" });
    expect(res).toContain("任务 b999 不存在");
  });

  it("status 查询失败任务：退出码写进状态文本，无启动错误时不带那一段", async () => {
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

    const res = await bashTaskTool.execute({ task_id: id, action: "status" });
    expect(res).toContain("失败（退出码 3）");
    expect(res).not.toContain("启动错误");
  });

  it.skipIf(process.platform !== "win32")(
    "启动失败的任务：status 返回失败原因，kill 也带出原因",
    async () => {
      // 只报「失败」时模型无从判断能否重试，错误原因必须一并返回（E150）。
      // 触发路径是真实的 spawn 失败：Windows 下 shell:true 用 ComSpec 指定的 shell，
      // 指向不存在的路径即 ENOENT。失败后 close 仍会到达（带 libuv 的 -4058），
      // 但 bash-background 的 running 守卫不写退出码，故错误文本是唯一原因
      const task = startTaskWithBrokenShell();
      await vi.waitFor(
        () => {
          expect(getBackgroundTask(task.id)?.error).toBeTruthy();
        },
        { timeout: 5000 },
      );
      const error = getBackgroundTask(task.id)!.error!;

      const status = await bashTaskTool.execute({ task_id: task.id, action: "status" });
      expect(status).toContain("失败");
      expect(status).toContain("启动错误");
      expect(status).toContain(error);

      // kill 对已失败任务按实际终态反馈：同样带出原因，模型少一次往返
      const killed = await bashTaskTool.execute({ task_id: task.id, action: "kill" });
      expect(killed).toContain("已于先前结束");
      expect(killed).toContain("失败");
      expect(killed).toContain(error);
    },
  );
});

describe("taskStateText（任务状态文本）", () => {
  // 真机用例（Windows 下打坏 ComSpec 触发 spawn 失败）只在本机平台跑，
  // 格式化逻辑与平台无关，这里逐分支断言，换平台运行也不丢覆盖
  it("启动失败：带出错误原文，无退出码时不加退出码段", () => {
    const task = { status: "failed", error: "spawn C:\\no-such-dir\\cmd.exe ENOENT" } as BackgroundTask;
    expect(taskStateText(task)).toBe("失败 · 启动错误：spawn C:\\no-such-dir\\cmd.exe ENOENT");
  });

  it("非零退出码：写退出码，无启动错误时不带那一段；两段都有时按退出码、启动错误依次排列", () => {
    expect(taskStateText({ status: "failed", exitCode: 3 } as BackgroundTask)).toBe("失败（退出码 3）");
    expect(taskStateText({ status: "failed", exitCode: 3, error: "boom" } as BackgroundTask)).toBe(
      "失败（退出码 3） · 启动错误：boom",
    );
  });

  it("运行中：只有状态名", () => {
    expect(taskStateText({ status: "running" } as BackgroundTask)).toBe("运行中");
  });
});

/**
 * 起一个必然启动失败的后台任务：把 ComSpec 临时指向不存在的 shell。
 * spawn 同步读该变量，调用后即还原，不影响本文件其它用例。
 */
function startTaskWithBrokenShell(): BackgroundTask {
  const original = process.env.ComSpec;
  process.env.ComSpec = path.join(os.tmpdir(), "minicode-no-such-shell", "cmd.exe");
  try {
    return startBackgroundTask("echo hi");
  } finally {
    if (original === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = original;
  }
}