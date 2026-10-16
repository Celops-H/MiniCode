/**
 * bash 失败回灌的信息量：失败回灌只有一行「命令失败」时，模型判不出该重跑还是改道。
 * 这里钉住失败结果的拼装口径——失败原因行、stderr 节、可重试标记排在 stdout 之前，
 * 诊断信息不被超限截断丢掉；stderr 超出摘要上限只留尾部。
 */
import { describe, expect, it, vi } from "vitest";
import { bashTool } from "../../src/tools/index.js";

// 起真实 shell/node 子进程：按自身耗时设独立超时，不用全局默认 5s
vi.setConfig({ testTimeout: 20_000 });

describe("bash 工具：失败回灌带 stderr 摘要与可重试标记", () => {
  it("非零退出：失败原因、stderr 节、可重试标记排在 stdout 之前", async () => {
    const out = await bashTool.execute({
      command: `node -e "console.log('OUT'); console.error('BOOM'); process.exit(3)"`,
    });
    expect(out).toMatchObject({ isError: true, error: "命令失败：退出码 3" });
    const text = (out as { output: string }).output;
    // 分区顺序：原因 → stderr 节 → 可重试标记 → stdout（大 stdout 被截断时丢的是尾部）
    const reasonAt = text.indexOf("命令失败：退出码 3");
    const stderrAt = text.indexOf("[stderr]");
    const boomAt = text.indexOf("BOOM");
    const markerAt = text.indexOf("[不可重试]");
    const stdoutAt = text.indexOf("OUT");
    expect(reasonAt).toBeGreaterThanOrEqual(0);
    expect(reasonAt).toBeLessThan(stderrAt);
    expect(stderrAt).toBeLessThan(boomAt);
    expect(boomAt).toBeLessThan(markerAt);
    expect(markerAt).toBeLessThan(stdoutAt);
  });

  it("stdout 为空时只出 stderr 节，不出现空行占位", async () => {
    const out = await bashTool.execute({ command: `node -e "console.error('BOOM'); process.exit(1)"` });
    expect((out as { output: string }).output).toBe("命令失败：退出码 1\n[stderr]\nBOOM\n[不可重试] 同一命令重跑结果不变，请先修正命令");
  });

  it("无 stderr 时不出 stderr 节", async () => {
    const out = await bashTool.execute({ command: `node -e "process.exit(4)"` });
    const text = (out as { output: string }).output;
    expect(text).not.toContain("[stderr]");
    expect(text).toContain("[不可重试]");
  });

  it("stderr 超出摘要上限只留尾部并标注", async () => {
    const out = await bashTool.execute({
      command: `node -e "console.error('HEAD' + 'x'.repeat(2500) + 'TAIL'); process.exit(1)"`,
    });
    const text = (out as { output: string }).output;
    expect(text).toContain("（仅末尾 2000 字符）");
    expect(text).toContain("TAIL");
    expect(text).not.toContain("HEAD");
  });

  it("超时：附可重试标记，提示加大 timeoutMs", async () => {
    const out = await bashTool.execute({ command: `node -e "setInterval(()=>{},1000)"`, timeoutMs: 200 });
    expect(out).toMatchObject({ isError: true, error: "命令执行超时：200ms 未退出" });
    const text = (out as { output: string }).output;
    expect(text).toContain("命令执行超时：200ms 未退出");
    expect(text).toContain("[可重试]");
    expect(text).toContain("timeoutMs");
  });

  it("用户打断：不带失败诊断与可重试标记，stderr 仍按节标签回灌", async () => {
    const controller = new AbortController();
    const promise = bashTool.execute(
      { command: `node -e "console.error('BOOM'); setInterval(()=>{},1000)"`, timeoutMs: 30000 },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort();
    const out = await promise;
    expect(out).toMatchObject({ isError: true });
    const text = (out as { output: string }).output;
    expect(text).toContain("已被用户打断");
    // 打断不算失败：不带失败原因行与可重试标记；stderr 照常分节（与成功回灌同口径）
    expect(text).toContain("[stderr]");
    expect(text).toContain("BOOM");
    expect(text).not.toContain("[可重试]");
    expect(text).not.toContain("[不可重试]");
  });
});
