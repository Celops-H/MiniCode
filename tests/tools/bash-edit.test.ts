import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bashTool, editTool } from "../../src/tools/index.js";

describe("bash 工具", () => {
  it("执行命令并返回输出", async () => {
    const out = await bashTool.execute({ command: "echo hello" });
    expect(out).toContain("hello");
  });

  it("失败命令返回错误信息", async () => {
    const out = await bashTool.execute({ command: "command-not-exist-xyz-123" });
    expect(out).toContain("命令失败");
  });
});

describe("edit 工具", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(): string {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-edit-"));
    return tmpDir;
  }

  it("精确替换唯一文本", async () => {
    const file = path.join(setup(), "a.ts");
    writeFileSync(file, "const a = 1;\nconst b = 2;");
    const out = await editTool.execute({
      path: file,
      oldString: "const a = 1;",
      newString: "const a = 10;",
    });
    expect(out).toContain("已替换");
    expect(await readFile(file, "utf8")).toBe("const a = 10;\nconst b = 2;");
  });

  it("待替换文本不唯一时拒绝", async () => {
    const file = path.join(setup(), "a.txt");
    writeFileSync(file, "x = 1\nx = 2");
    const out = await editTool.execute({ path: file, oldString: "x", newString: "y" });
    expect(out).toContain("唯一匹配");
  });

  it("未找到待替换文本时报错", async () => {
    const file = path.join(setup(), "a.txt");
    writeFileSync(file, "hello");
    const out = await editTool.execute({ path: file, oldString: "nope", newString: "y" });
    expect(out).toContain("未找到");
  });
});
