import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileState, readTool, withFileState } from "../../src/tools/index.js";

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

  it("同区间重复读、内容未变、旧结果仍在上下文：回 stub，不重复回灌全文", async () => {
    const { file, state } = setup();
    const first = await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c1" }));
    expect(first).toBe("1\t第一行\n2\t第二行");

    const second = await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c2" }));
    expect(second).toContain("文件未变化");
    expect(second).toContain("第 1 行起");
    expect(second).not.toContain("第一行");
  });

  it("区间不同不回 stub：改读另一段照常回全文", async () => {
    const { file, state } = setup("一\n二\n三\n四");
    await withFileState(state, () => readTool.execute({ path: file, limit: 2 }, { toolCallId: "c1" }));
    const other = await withFileState(state, () => readTool.execute({ path: file, offset: 3 }, { toolCallId: "c2" }));
    expect(other).toBe("3\t三\n4\t四");
  });

  it("内容 hash 变了不回 stub：外部改写后同区间重读回全文，刷新后再读回 stub", async () => {
    const { file, state } = setup("旧内容");
    await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c1" }));

    writeFileSync(file, "新内容");
    const changed = await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c2" }));
    expect(changed).toBe("1\t新内容");

    const again = await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c3" }));
    expect(again).toContain("文件未变化");
  });

  it("旧结果被摘除（修剪/压缩）后同区间重读必须回全文", async () => {
    const { file, state } = setup("正文");
    await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c1" }));

    // 模拟修剪/压缩：产出该结果的调用不再存活（上下文里只剩其它调用）
    state.retainReads(new Set(["other"]));

    const out = await withFileState(state, () => readTool.execute({ path: file }, { toolCallId: "c2" }));
    expect(out).toBe("1\t正文");
  });

  it("无调用身份（无 toolCallId）不去重：每次都回全文", async () => {
    const { file, state } = setup("内容");
    const first = await withFileState(state, () => readTool.execute({ path: file }));
    const second = await withFileState(state, () => readTool.execute({ path: file }));
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

    await withFileState(state, () => readTool.execute({ path: kept }, { toolCallId: "keep" }));
    await withFileState(state, () => readTool.execute({ path: dropped }, { toolCallId: "drop" }));
    state.retainReads(new Set(["keep"]));

    const keptAgain = await withFileState(state, () => readTool.execute({ path: kept }, { toolCallId: "k2" }));
    const droppedAgain = await withFileState(state, () => readTool.execute({ path: dropped }, { toolCallId: "d2" }));
    expect(keptAgain).toContain("文件未变化");
    expect(droppedAgain).toBe("1\t摘除");
  });
});
