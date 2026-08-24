import { describe, expect, it } from "vitest";
import { bashTool } from "../../src/tools/index.js";

const delay = (ms: number): Promise<string> => new Promise((resolve) => setTimeout(() => resolve("RUNNING"), ms));

describe("bash 工具：signal 中止（turn 内打断透传）", () => {
  it("执行中触发 abort：杀进程树并快速返回失败标记", async () => {
    const controller = new AbortController();
    // 长驻命令：不主动退出，靠外部 abort 终止（30 秒超时仅兜底，防止中止失效时测试挂死）
    let promise: ReturnType<typeof bashTool.execute>;
    promise = bashTool.execute(
      { command: 'node -e "setInterval(()=>{},1000)"', timeoutMs: 30000 },
      { signal: controller.signal },
    );
    // 命令仍在运行（先于任意结果返回），说明挂起被观察到
    const early = await Promise.race([promise, delay(500)]);
    expect(early).toBe("RUNNING");

    controller.abort();
    const result = await promise;
    expect(result).toMatchObject({ isError: true });
    expect(String(JSON.stringify(result))).toContain("已被用户打断");
  });

  it("正常命令不受 signal 影响：输出与未传 signal 一致", async () => {
    const out = await bashTool.execute({ command: "echo hello" }, { signal: new AbortController().signal });
    expect(out).toContain("hello");
  });
});