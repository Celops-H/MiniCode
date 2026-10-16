import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileState, readTool, withFileState, type ExecuteResult } from "../../src/tools/index.js";

describe("read 读去重（同区间同内容回 stub）", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(content = "第一行\n第二行"): { file: string; state: FileState } {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-dedup-"));
    const file = path.join(tmpDir, "a.txt");
    writeFileSync(file, content);
    return { file, state: new FileState() };
  }

  /**
   * 取输出文本，并应用上下文修改：读记录登记延后到结果交付，
   * 执行器在结果未被截断时应用该修改（这里手工应用，等价于正常交付）。
   */
  function out(result: ExecuteResult): string {
    if (typeof result === "string") return result;
    result.contextModifier?.();
    return result.output;
  }

  it("同区间重复读、内容未变、旧结果仍在上下文：回 stub，不重复回灌全文", async () => {
    const { file, state } = setup();
    const first = out(await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c1" })));
    expect(first).toBe("1\t第一行\n2\t第二行");

    const second = out(await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c2" })));
    expect(second).toContain("文件未变化");
    expect(second).toContain("第 1 行起");
    expect(second).not.toContain("第一行");
  });

  it("区间不同不回 stub：改读另一段照常回全文", async () => {
    const { file, state } = setup("一\n二\n三\n四");
    out(await withFileState(state, () => readTool.execute({ path: file, limit: 2 }, { toolCallId: "c1" })));
    const other = out(
      await withFileState(state, () => readTool.execute({ path: file, offset: 3 }, { toolCallId: "c2" })),
    );
    expect(other).toBe("3\t三\n4\t四");
  });

  it("内容 hash 变了不回 stub：外部改写后同区间重读回全文，刷新后再读回 stub", async () => {
    const { file, state } = setup("旧内容");
    out(await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c1" })));

    writeFileSync(file, "新内容");
    const changed = out(await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c2" })));
    expect(changed).toBe("1\t新内容");

    const again = out(await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c3" })));
    expect(again).toContain("文件未变化");
  });

  it("旧结果被摘除（修剪/压缩）后同区间重读必须回全文", async () => {
    const { file, state } = setup("正文");
    out(await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c1" })));

    // 模拟修剪/压缩：产出该结果的调用不再存活（上下文里只剩其它调用）
    state.retainReads(new Set(["other"]));

    const result = await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c2" }));
    expect(out(result)).toBe("1\t正文");
  });

  it("结果超上限会被截断时不登记：同区间重读仍回全文", async () => {
    // 结果文本 = 行号前缀 + 内容：30001 字符内容渲染后超 30000 上限，
    // 交付出去只是截断预览，登记会让同区间重读回 stub 指向截断预览
    const { file, state } = setup("x".repeat(30001));
    const first = await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c1" }));
    expect(typeof first).toBe("string");

    const second = out(await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c2" })));
    expect(second).not.toContain("文件未变化");
    expect(second.length).toBe(30003);
  });

  it("无调用身份（无 toolCallId）不去重：每次都回全文", async () => {
    const { file, state } = setup("内容");
    const first = out(await withFileState(state, () => readTool.execute({ path: file })));
    const second = out(await withFileState(state, () => readTool.execute({ path: file })));
    expect(first).toBe("1\t内容");
    expect(second).toBe("1\t内容");
  });

  it("retainReads 只保留存活调用：存活的回 stub，被摘除的回全文", async () => {
    const dir = tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-dedup-"));
    const kept = path.join(dir, "kept.txt");
    const dropped = path.join(dir, "dropped.txt");
    writeFileSync(kept, "保留");
    writeFileSync(dropped, "摘除");
    const state = new FileState();

    out(await withFileState(state, () => readTool.execute({ path: kept }, { toolCallId: "keep" })));
    out(await withFileState(state, () => readTool.execute({ path: dropped }, { toolCallId: "drop" })));
    state.retainReads(new Set(["keep"]));

    const keptAgain = out(await withFileState(state, () => readTool.execute({ path: kept }, { toolCallId: "k2" })));
    const droppedAgain = out(
      await withFileState(state, () => readTool.execute({ path: dropped }, { toolCallId: "d2" })),
    );
    expect(keptAgain).toContain("文件未变化");
    expect(droppedAgain).toBe("1\t摘除");
  });

  it("recentReads 按读取先后倒序，同路径只留最近一次", async () => {
    const dir = tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-reads-"));
    const a = path.join(dir, "a.txt");
    const b = path.join(dir, "b.txt");
    writeFileSync(a, "一\n二");
    writeFileSync(b, "三");
    const state = new FileState();

    out(await withFileState(state, () => readTool.execute({ path: a, limit: 1 }, { toolCallId: "c1" })));
    out(await withFileState(state, () => readTool.execute({ path: b }, { toolCallId: "c2" })));
    // 再读 a 的另一区间：新记录排在 b 之后，a 在候选里只出现一次
    out(await withFileState(state, () => readTool.execute({ path: a, offset: 2 }, { toolCallId: "c3" })));

    expect(state.recentReads()).toEqual([
      { path: a, offset: 2, limit: undefined, toolCallId: "c3", contentHash: expect.any(String), seq: 3 },
      { path: b, offset: 1, limit: undefined, toolCallId: "c2", contentHash: expect.any(String), seq: 2 },
    ]);
  });

  it("recentReads 无读记录时为空", () => {
    expect(new FileState().recentReads()).toEqual([]);
  });
});
