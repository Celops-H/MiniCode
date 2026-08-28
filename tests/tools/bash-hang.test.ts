import { describe, expect, it } from "vitest";
import { bashTool } from "../../src/tools/index.js";

/**
 * 复现「命令进程已退出，但 stdio 管道被别的进程持有」导致工具长时间无返回
 * （工具系统问题记录 2026-08-27 问题 2）：
 * - Windows 用 start /b 拉起后台 node，Unix 用 & 后台任务——两者都继承 stdout 句柄，
 *   shell 退出后管道写端仍被孙进程攥着，「close」迟迟不来；
 * - 修复语义：进程退出 + 短暂排水窗口（1 秒）后强制收尾，不等管道自然关闭；
 * - 另钉住 stdin 语义：工具执行是非交互的，等待输入的命令读到 EOF（stdin 已关闭）
 *   即退出，不挂到超时被杀。
 */
describe("bash 工具：进程退出但管道被持有 / stdin 关闭（问题记录 2026-08-27 问题 2）", () => {
  const holdPipeCommand =
    process.platform === "win32"
      ? 'start "" /b node -e "setTimeout(function(){process.exit(0)},15000)" & echo DONE'
      : 'node -e "setTimeout(function(){process.exit(0)},15000)" & echo DONE';

  it("shell 正常退出后不等待被孙进程继承的管道：输出完整返回，不拖到超时", async () => {
    const out = await bashTool.execute({ command: holdPipeCommand, timeoutMs: 4000 });
    expect(String(out)).toContain("DONE");
    expect(String(out)).not.toContain("执行超时");
  }, 15000);

  it("命令等待 stdin 时读到 EOF 立即退出（stdin 已关闭，不挂到超时）", async () => {
    const out = await bashTool.execute({ command: 'node -e "process.stdin.resume()"', timeoutMs: 4000 });
    expect(String(out)).toContain("(命令无输出)");
    expect(String(out)).not.toContain("执行超时");
  }, 15000);

  it("排水窗口内孙进程晚到的输出被收集（shell 退出后 300ms 才写，不因强制收尾丢失）", async () => {
    const lateWriteCommand =
      process.platform === "win32"
        ? 'start "" /b node -e "setTimeout(function(){console.log(39)},300)" & echo DONE'
        : 'node -e "setTimeout(function(){console.log(39)},300)" & echo DONE';
    const out = await bashTool.execute({ command: lateWriteCommand, timeoutMs: 4000 });
    expect(String(out)).toContain("DONE");
    expect(String(out)).toContain("39");
  }, 15000);

  // P1 回归钉：Unix 超时走 SIGKILL，exit 事件 code 为 null——结算判定不能用 exitCode 判退出，
  // 否则超时/打断路径永不结算。Windows taskkill 产生退出码 1 无此形态，用例仅在 Unix 跑。
  it.skipIf(process.platform === "win32")("信号杀（SIGKILL，exit code 为 null）后超时路径正常结算", async () => {
    const out = await bashTool.execute({ command: 'node -e "setInterval(()=>{},1000)"', timeoutMs: 300 });
    expect(out).toMatchObject({ isError: true });
    expect(String(JSON.stringify(out))).toContain("执行超时");
  }, 15000);
});
