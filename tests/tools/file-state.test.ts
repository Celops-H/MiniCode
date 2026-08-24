import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editTool, FileState, readTool, withFileState, writeTool } from "../../src/tools/index.js";

describe("文件写冲突防护（DESIGN 7.6 per-agent 快照）", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(): string {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-fs-"));
    return tmpDir;
  }

  it("read 后 edit 正常通过，并刷新快照", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "hello world");
    const state = new FileState();

    await withFileState(state, () => readTool.execute({ path: file }));
    const out = await withFileState(state, () => editTool.execute({ path: file, oldString: "hello", newString: "bye" }));
    expect(out).toBe("已替换 1 处");
    expect(await readFile(file, "utf8")).toBe("bye world");
  });

  it("read 后外部修改文件，write 拒绝（第二个写者不受阻的修复）", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "v1");
    const stateA = new FileState();
    const stateB = new FileState();

    // A 与 B 都读到 v1
    await withFileState(stateA, () => readTool.execute({ path: file }));
    await withFileState(stateB, () => readTool.execute({ path: file }));

    // A 先写 v2：通过，只刷 A 的快照
    const outA = await withFileState(stateA, () => writeTool.execute({ path: file, content: "v2" }));
    expect(outA).toBe(`已写入 ${file}`);
    expect(await readFile(file, "utf8")).toBe("v2");

    // B 仍持 v1 快照，磁盘已是 v2 → 拒绝，不能静默覆盖 A 的成果
    const outB = await withFileState(stateB, () => writeTool.execute({ path: file, content: "v3" }));
    expect(outB).toContain("文件已被外部或其他 Agent 修改，请重新 Read 后再写");
    expect(await readFile(file, "utf8")).toBe("v2");
  });

  describe.skipIf(process.platform !== "win32")("Windows 路径大小写归一（DESIGN 7.6）", () => {
    it("read 小写路径后，大写路径的外部修改命中同一快照（write 拒绝）", async () => {
      const dir = setup();
      const file = path.join(dir, "a.txt");
      writeFileSync(file, "v1");
      const state = new FileState();

      // read 用小写路径登记快照
      await withFileState(state, () => readTool.execute({ path: file }));
      // 外部用大写路径修改（Windows 大小写不敏感，同一文件）
      writeFileSync(path.join(dir, "A.TXT"), "v2");
      // 用小写路径 write：快照键已归一，命中 v1 快照 → 拒绝
      const out = await withFileState(state, () => writeTool.execute({ path: file, content: "v3" }));
      expect(out).toContain("文件已被外部或其他 Agent 修改，请重新 Read 后再写");
      expect(await readFile(file, "utf8")).toBe("v2");
    });
  });

  it("同一 agent 重复 write 不误伤（写后刷自己的快照）", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "v1");
    const state = new FileState();

    await withFileState(state, () => readTool.execute({ path: file }));
    await withFileState(state, () => writeTool.execute({ path: file, content: "v2" }));
    const out = await withFileState(state, () => writeTool.execute({ path: file, content: "v3" }));
    expect(out).toBe(`已写入 ${file}`);
    expect(await readFile(file, "utf8")).toBe("v3");
  });

  it("mtime 抖动兜底：内容一致放行，内容不一致拒绝", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "same content");
    const state = new FileState();
    await withFileState(state, () => readTool.execute({ path: file }));

    // 模拟抖动：内容不变但重写文件（mtime 变化）
    writeFileSync(file, "same content");
    const out = await withFileState(state, () => editTool.execute({ path: file, oldString: "same", newString: "same" }));
    expect(out).toBe("已替换 1 处");

    // 内容真的变了 → 拒绝
    writeFileSync(file, "changed content");
    const out2 = await withFileState(state, () => writeTool.execute({ path: file, content: "x" }));
    expect(out2).toContain("文件已被外部或其他 Agent 修改");
  });

  it("部分读不记录 hash，mtime 变化且无法兜底时拒绝", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "line1\nline2\nline3");
    const state = new FileState();

    // 部分读（limit）→ 无 hash，只有 mtime+size
    await withFileState(state, () => readTool.execute({ path: file, limit: 1 }));
    // 内容变但长度相同 → 无法 hash 兜底，拒绝
    writeFileSync(file, "line1\nline9\nline3");
    const out = await withFileState(state, () => writeTool.execute({ path: file, content: "x" }));
    expect(out).toContain("文件已被外部或其他 Agent 修改");
  });

  it("从未读过的文件直接写：新建/覆盖语义，不拒绝", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "old");
    const state = new FileState();

    const out = await withFileState(state, () => writeTool.execute({ path: file, content: "new" }));
    expect(out).toBe(`已写入 ${file}`);
    expect(await readFile(file, "utf8")).toBe("new");
  });

  it("无 agent 上下文（直接调用工具）保持原行为，不校验", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "v1");

    const out = await writeTool.execute({ path: file, content: "v2" });
    expect(out).toBe(`已写入 ${file}`);
    expect(await readFile(file, "utf8")).toBe("v2");
  });

  it("per-path 锁串行化同路径并发写，不同路径并行", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "v1");
    const state = new FileState();
    await withFileState(state, () => readTool.execute({ path: file }));

    // 同路径并发写：锁保证串行，第二个在第一个刷新快照后校验通过
    const [r1, r2] = await Promise.all([
      withFileState(state, () => writeTool.execute({ path: file, content: "w1" })),
      withFileState(state, () => writeTool.execute({ path: file, content: "w2" })),
    ]);
    expect(r1).toBe(`已写入 ${file}`);
    expect(r2).toBe(`已写入 ${file}`);
    expect(await readFile(file, "utf8")).toBe("w2");
  });

  it("跨 FileState（多 agent）并发写同一文件：后写者被拒，不静默覆盖", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "v1");
    const stateA = new FileState();
    const stateB = new FileState();

    // A 与 B 都读到 v1（各自快照）
    await withFileState(stateA, () => readTool.execute({ path: file }));
    await withFileState(stateB, () => readTool.execute({ path: file }));

    // 并发写：模块级锁串行化临界区；先写者成功并刷自己快照，
    // 后写者校验磁盘（已被先写者更新）vs 自己旧快照 → 拒绝
    const [ra, rb] = await Promise.all([
      withFileState(stateA, () => writeTool.execute({ path: file, content: "A 的版本" })),
      withFileState(stateB, () => writeTool.execute({ path: file, content: "B 的版本" })),
    ]);

    const results = [ra, rb];
    expect(results.filter((r) => r === `已写入 ${file}`)).toHaveLength(1);
    expect(results.filter((r) => typeof r === "string" && r.includes("文件已被外部或其他 Agent 修改"))).toHaveLength(1);
    const finalContent = await readFile(file, "utf8");
    expect(["A 的版本", "B 的版本"]).toContain(finalContent);
  });

  it("mkdir 场景：write 到新目录新文件正常", async () => {
    const dir = setup();
    const file = path.join(dir, "nested", "deep", "a.txt");
    mkdirSync(path.dirname(file), { recursive: true });
    const state = new FileState();

    const out = await withFileState(state, () => writeTool.execute({ path: file, content: "x" }));
    expect(out).toBe(`已写入 ${file}`);
    expect(await readFile(file, "utf8")).toBe("x");
  });
});