import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spillOutput } from "../../src/tools/overflow.js";
import { bashTool } from "../../src/tools/index.js";

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

  it("带截断补充提示时作为独立一行附在落盘提示之后", () => {
    const full = "y".repeat(200);
    const result = spillOutput(full, 20, outDir, {}, "结果不完整，建议缩小范围或改用内置 grep 搜索");
    const lines = result.content.split("\n");
    const last = lines[lines.length - 1];
    expect(last).toBe("[结果不完整，建议缩小范围或改用内置 grep 搜索]");
    // 与落盘提示并列两条
    expect(lines[lines.length - 2]).toContain("完整内容已保存到");
  });

  it("未提供补充提示时不额外附行", () => {
    const result = spillOutput("z".repeat(200), 20, outDir);
    expect(result.content.endsWith("]")).toBe(true);
    expect(result.content.split("\n").at(-1)).not.toContain("建议缩小");
  });

  it("文件名编入会话 id 与工具名（产出方可回溯），非法字符归一", () => {
    const full = "y".repeat(100);
    const result = spillOutput(full, 10, outDir, { sessionId: "550e8400-e29b-41d4-a716-446655440000", toolName: "mcp__srv__search" });
    expect(result.outputPath).toBeDefined();
    const name = path.basename(result.outputPath!);
    expect(name).toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(name).toContain("mcp__srv__search");
    expect(readFileSync(result.outputPath!, "utf8")).toBe(full);
  });

  it("不带归属信息时保持 tool-<毫秒>-<随机> 命名（向后兼容）", () => {
    const result = spillOutput("z".repeat(100), 10, outDir);
    const name = path.basename(result.outputPath!);
    expect(name).toMatch(/^tool-\d+-[0-9a-f]{8}\.txt$/);
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

  it("bash 输出超上限时回灌末尾带截断建议（执行层按 maxResultSizeChars 截断）", async () => {
    const out = await bashTool.execute({
      command: `node -e "process.stdout.write('x'.repeat(40000))"`,
    });
    const result = spillOutput(
      String(out),
      bashTool.maxResultSizeChars,
      outDir,
      {},
      bashTool.truncationNote,
    );
    expect(result.truncated).toBe(true);
    // 落盘提示与截断建议并列两条，各讲一件事
    expect(result.content).toContain("完整内容已保存到");
    expect(result.content).toContain("结果不完整，建议缩小命令范围或改用内置 grep 搜索");
  });
});
