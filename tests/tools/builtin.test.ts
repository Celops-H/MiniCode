import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileTools } from "../../src/tools/index.js";
import type { Tool } from "../../src/tools/index.js";

describe("文件类内置工具", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(): string {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-tools-"));
    return tmpDir;
  }

  function tool(name: string): Tool {
    const t = createFileTools().find((x) => x.name === name);
    if (!t) throw new Error(`工具不存在：${name}`);
    return t;
  }

  it("read 读取文件并带行号", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "第一行\n第二行\n第三行");
    const out = await tool("read").execute({ path: file });
    expect(out).toBe("1\t第一行\n2\t第二行\n3\t第三行");
  });

  it("read 支持行范围", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "一\n二\n三\n四");
    const out = await tool("read").execute({ path: file, offset: 1, limit: 2 });
    expect(out).toBe("2\t二\n3\t三");
  });

  it("write 写入文件并自动创建父目录", async () => {
    const dir = setup();
    const file = path.join(dir, "sub", "b.txt");
    const out = await tool("write").execute({ path: file, content: "你好" });
    expect(out).toContain("已写入");
    expect(await readFile(file, "utf8")).toBe("你好");
  });

  it("glob 匹配文件", async () => {
    const dir = setup();
    writeFileSync(path.join(dir, "a.ts"), "");
    writeFileSync(path.join(dir, "b.js"), "");
    const out = await tool("glob").execute({ pattern: "**/*.ts", path: dir });
    expect(out).toContain("a.ts");
    expect(out).not.toContain("b.js");
  });

  it("grep 按正则搜索内容", async () => {
    const dir = setup();
    writeFileSync(path.join(dir, "a.ts"), "const x = 1;\nlet y = 2;");
    writeFileSync(path.join(dir, "b.txt"), "没有匹配");
    const out = await tool("grep").execute({ pattern: "let ", path: dir });
    expect(out).toContain("a.ts:2");
    expect(out).not.toContain("b.txt");
  });

  it("grep 支持 glob 过滤", async () => {
    const dir = setup();
    writeFileSync(path.join(dir, "a.ts"), "匹配行 xyz");
    writeFileSync(path.join(dir, "b.txt"), "匹配行 xyz");
    const out = await tool("grep").execute({ pattern: "xyz", path: dir, glob: "*.ts" });
    expect(out).toContain("a.ts");
    expect(out).not.toContain("b.txt");
  });

  it("无匹配时返回提示", async () => {
    const dir = setup();
    writeFileSync(path.join(dir, "a.txt"), "内容");
    const out = await tool("grep").execute({ pattern: "不存在", path: dir });
    expect(out).toBe("未找到匹配内容");
  });

  it("grep 深度超限时标记结果不完整", async () => {
    const dir = setup();
    // 构造 13 层嵌套目录（超过 12 层上限）使搜索截断
    let deep = dir;
    for (let i = 0; i < 13; i++) deep = path.join(deep, "d");
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, "deep.txt"), "深处匹配");
    const out = await tool("grep").execute({ pattern: "深处", path: dir });
    expect(out).toContain("深度超限");
  });
});
