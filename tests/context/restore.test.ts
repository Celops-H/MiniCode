import { describe, expect, it } from "vitest";
import { buildRestore, type RestoreFile } from "../../src/context/index.js";

/** 默认预算：单文件 5 字符上限外的宽松值，便于单独验证某个维度 */
const ROOMY = { maxCharsPerFile: 5000, maxTotalChars: 50000 };

function file(path: string, content: string): RestoreFile {
  return { path, content };
}

describe("压缩后回注正文组装", () => {
  it("按行号格式化，多文件按给定顺序分段", () => {
    const result = buildRestore([file("a.txt", "一\n二"), file("b.txt", "三")], ROOMY);
    expect(result.text).toContain("以下文件压缩前读过");
    expect(result.text).toContain("文件：a.txt\n1\t一\n2\t二");
    expect(result.text).toContain("文件：b.txt\n1\t三");
    expect(result.complete).toEqual([file("a.txt", "一\n二"), file("b.txt", "三")]);
  });

  it("单文件超上限按行边界截断，附截断说明且不计入 complete", () => {
    // header「文件：a.txt」8 字符，每行项另计 1 个换行符：上限 19 只装得下第 1 行
    const result = buildRestore([file("a.txt", "第一行\n第二行")], { maxCharsPerFile: 19, maxTotalChars: 5000 });
    expect(result.text).toContain("1\t第一行");
    expect(result.text).not.toContain("第二行");
    expect(result.text).toContain("文件过长");
    expect(result.complete).toEqual([]);
  });

  it("总预算装不下的文件整条跳过，其后装得下的仍回注", () => {
    // 前言已占 36 字符，预算 80：两个大文件各条都放不下、整条跳过，末尾小文件仍入
    const big = "x".repeat(100);
    const result = buildRestore([file("big.txt", big), file("mid.txt", "y".repeat(60)), file("s.txt", "z")], {
      maxCharsPerFile: 5000,
      maxTotalChars: 80,
    });
    expect(result.text).not.toContain("big.txt");
    expect(result.text).not.toContain("mid.txt");
    expect(result.text).toContain("s.txt");
  });

  it("无文件可用时正文为空串", () => {
    expect(buildRestore([], ROOMY)).toEqual({ text: "", complete: [] });
    // 预算容不下任何一个文件，同样回空串（调用方据此不回注）
    expect(buildRestore([file("a.txt", "内容")], { maxCharsPerFile: 5000, maxTotalChars: 10 }).text).toBe("");
  });
});
