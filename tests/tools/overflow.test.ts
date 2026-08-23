import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spillOutput } from "../../src/tools/overflow.js";

describe("spillOutput（工具输出超限落盘）", () => {
  let dir: string;
  let outDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "minicode-overflow-"));
    outDir = path.join(dir, "outputs");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("未超限：原样返回，不落盘", () => {
    const result = spillOutput("hello", 100, outDir);
    expect(result).toEqual({
      content: "hello",
      truncated: false,
      originalLength: 5,
    });
    expect(result.outputPath).toBeUndefined();
  });

  it("超限：完整内容落盘，回灌预览与路径提示", () => {
    const full = "line1\nline2\nline3\n" + "x".repeat(200);
    const result = spillOutput(full, 20, outDir);

    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(full.length);
    expect(result.outputPath).toBeDefined();
    // 落盘文件内容完整无损
    expect(readFileSync(result.outputPath!, "utf8")).toBe(full);
    // 回灌文本含截断预览与路径提示
    expect(result.content).toContain("完整内容已保存到");
    expect(result.content).toContain(result.outputPath!);
    expect(result.content).toContain("可用 Read 工具读取");
    expect(result.content.length).toBeLessThan(full.length);
  });

  it("落盘失败（输出目录被文件占位）：退化为纯截断标记", () => {
    // 用同名文件占位输出目录路径，使 mkdirSync 抛错 → 退化为截断
    const blocked = path.join(dir, "blocked");
    writeFileSync(blocked, "occupied");
    const result = spillOutput("a".repeat(50), 10, blocked);

    expect(result.truncated).toBe(true);
    expect(result.outputPath).toBeUndefined();
    expect(result.content).toContain("保留前 10 字符");
    expect(result.content).not.toContain("完整内容已保存到");
  });
});