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

  it("失败命令返回错误信息并标记失败", async () => {
    const out = await bashTool.execute({ command: "command-not-exist-xyz-123" });
    expect(out).toMatchObject({ isError: true });
    expect(String(JSON.stringify(out))).toContain("命令失败");
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

  it("精确替换唯一文本，回灌带行号与上下片段", async () => {
    const file = path.join(setup(), "a.ts");
    writeFileSync(file, "l1\nl2\nconst a = 1;\nl4\nl5");
    const out = await editTool.execute({
      path: file,
      oldString: "const a = 1;",
      newString: "const a = 10;",
    });
    expect(out).toContain("已替换 1 处（第 3 行）");
    // 带行号的改动行与前后上下文（与 read 的 行号\t内容 同口径）
    expect(out).toContain("3\tconst a = 10;");
    expect(out).toContain("2\tl2");
    expect(out).toContain("4\tl4");
    expect(await readFile(file, "utf8")).toBe("l1\nl2\nconst a = 10;\nl4\nl5");
  });

  it("待替换文本不唯一时抛错并附次数", async () => {
    const file = path.join(setup(), "a.txt");
    writeFileSync(file, "x = 1\nx = 2");
    await expect(
      editTool.execute({ path: file, oldString: "x", newString: "y" }),
    ).rejects.toThrow(/待替换文本出现 2 次，须唯一匹配/);
  });

  it("未找到待替换文本时抛错并附原因", async () => {
    const file = path.join(setup(), "a.txt");
    writeFileSync(file, "hello");
    await expect(
      editTool.execute({ path: file, oldString: "nope", newString: "y" }),
    ).rejects.toThrow(/未找到待替换的文本/);
  });
});
