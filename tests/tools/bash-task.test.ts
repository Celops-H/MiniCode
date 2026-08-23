import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bashTaskTool,
  bashTool,
  getBackgroundTask,
  killAllBackgroundTasks,
} from "../../src/tools/index.js";

afterEach(() => {
  killAllBackgroundTasks();
});

describe("bash_task 工具", () => {
  it("status 查询已完成任务，返回状态与累积输出", async () => {
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