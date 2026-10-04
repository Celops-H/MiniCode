import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bashTaskTool,
  bashTool,
  getBackgroundTask,
  killAllBackgroundTasks,
} from "../../src/tools/index.js";

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
});