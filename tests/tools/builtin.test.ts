import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuiltinTools } from "../../src/tools/index.js";
import { spillOutput } from "../../src/tools/overflow.js";
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
    const t = createBuiltinTools().find((x) => x.name === name);
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

  it("read offset 超出文件行数时返回越界提示", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "一\n二\n三");
    const out = await tool("read").execute({ path: file, offset: 10 });
    expect(out).toContain("超出文件行数");
    expect(out).toContain("3 行");
    expect(out).toContain("从 1 起");
  });

  it("read 支持行范围，offset 与输出行号同为 1 基", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "一\n二\n三\n四");
    const out = await tool("read").execute({ path: file, offset: 2, limit: 2 });
    expect(out).toBe("2\t二\n3\t三");
  });

  it("read 的 offset 从 1 起：传 0 校验失败，不静默按文件头处理", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "一\n二");
    await expect(tool("read").execute({ path: file, offset: 0 })).rejects.toThrow();
  });

  it("read 打在目录上时列出条目并给指路提示，不抛 EISDIR 裸错误", async () => {
    const dir = setup();
    mkdirSync(path.join(dir, "子目录"));
    writeFileSync(path.join(dir, "a.txt"), "内容");
    const out = await tool("read").execute({ path: dir });
    expect(out).toContain("是目录，不是文件");
    expect(out).toContain("2 个条目");
    expect(out).toContain("子目录/");
    expect(out).toContain("a.txt");
    expect(out).toContain("glob");
  });

  it("read 打在空目录上时提示 0 个条目与指路，不抛 EISDIR 裸错误", async () => {
    const dir = setup();
    mkdirSync(path.join(dir, "empty"));
    const out = await tool("read").execute({ path: path.join(dir, "empty") });
    expect(out).toContain("是目录，不是文件");
    expect(out).toContain("0 个条目");
    expect(out).toContain("glob");
  });

  it("read 打在不存在的路径上返回可读提示，不抛 ENOENT 裸系统错误（口径同 grep）", async () => {
    const dir = setup();
    const out = await tool("read").execute({ path: path.join(dir, "没有这个文件.txt") });
    expect(out).toContain("读取路径不存在");
    expect(out).toContain("没有这个文件.txt");
    expect(out).not.toContain("ENOENT");
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

  it("glob 描述与 grep/read 划分工并声明结果不保证排序", () => {
    const description = tool("glob").description;
    expect(description).toContain("grep");
    expect(description).toContain("read");
    expect(description).toContain("不保证排序");
  });

  it("read 与 glob 声明截断建议：超限回灌在落盘提示后附缩小范围一行", () => {
    const dir = setup();
    for (const name of ["read", "glob"]) {
      const t = tool(name);
      expect(t.truncationNote, name).toBeTruthy();
      expect(t.truncationNote, name).toContain("不完整");
      const result = spillOutput("x".repeat(500), 100, path.join(dir, "outputs"), {}, t.truncationNote);
      expect(result.truncated).toBe(true);
      // 落盘提示与截断建议并列两行，各讲一件事
      expect(result.content).toContain("完整内容已保存到");
      expect(result.content).toContain(`[${t.truncationNote}]`);
    }
    // read 有文件与目录两条返回路径，截断建议要分别给出可用手段
    expect(tool("read").truncationNote).toContain("offset");
    expect(tool("read").truncationNote).toContain("glob");
  });

  it("grep 跳过二进制文件：NUL 嗅探，乱码不再喂给模型", async () => {
    const dir = setup();
    writeFileSync(path.join(dir, "real.txt"), "has match here");
    // 二进制文件：NUL 字节开头 + 内文含匹配词（旧实现乱码行会命中正则）
    writeFileSync(path.join(dir, "bin.dat"), Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from("has match garbage")]));
    const out = await tool("grep").execute({ pattern: "match", path: dir });
    expect(out).toContain("real.txt");
    expect(out).not.toContain("bin.dat");
  });

  it("grep 按正则搜索内容", async () => {
    const dir = setup();
    writeFileSync(path.join(dir, "a.ts"), "const x = 1;\nlet y = 2;");
    writeFileSync(path.join(dir, "b.txt"), "没有匹配");
    const out = await tool("grep").execute({ pattern: "let ", path: dir });
    expect(out).toContain("a.ts:2");
    expect(out).not.toContain("b.txt");
  });

  it("grep 支持 include 过滤文件名", async () => {
    const dir = setup();
    writeFileSync(path.join(dir, "a.ts"), "匹配行 xyz");
    writeFileSync(path.join(dir, "b.txt"), "匹配行 xyz");
    const out = await tool("grep").execute({ pattern: "xyz", path: dir, include: "*.ts" });
    expect(out).toContain("a.ts");
    expect(out).not.toContain("b.txt");
  });

  it("grep include 支持 {a,b} 任选其一", async () => {
    const dir = setup();
    writeFileSync(path.join(dir, "a.ts"), "匹配行 xyz");
    writeFileSync(path.join(dir, "b.tsx"), "匹配行 xyz");
    writeFileSync(path.join(dir, "c.txt"), "匹配行 xyz");
    const out = await tool("grep").execute({ pattern: "xyz", path: dir, include: "*.{ts,tsx}" });
    expect(out).toContain("a.ts");
    expect(out).toContain("b.tsx");
    expect(out).not.toContain("c.txt");
  });

  it("grep include 带目录段时按相对路径匹配（目录段不再被静默忽略）", async () => {
    const dir = setup();
    mkdirSync(path.join(dir, "src", "sub"), { recursive: true });
    writeFileSync(path.join(dir, "src", "a.ts"), "匹配行 xyz");
    writeFileSync(path.join(dir, "src", "sub", "deep.ts"), "匹配行 xyz");
    writeFileSync(path.join(dir, "root.ts"), "匹配行 xyz");
    // src/*.ts 只命中 src 直下一层；**/*.ts 命中任意层级
    const shallow = await tool("grep").execute({ pattern: "xyz", path: dir, include: "src/*.ts" });
    expect(shallow).toContain(path.join("src", "a.ts"));
    expect(shallow).not.toContain("deep.ts");
    expect(shallow).not.toContain("root.ts");
    const deep = await tool("grep").execute({ pattern: "xyz", path: dir, include: "**/*.ts" });
    expect(deep).toContain(path.join("src", "sub", "deep.ts"));
    expect(deep).toContain("root.ts");
  });

  it("grep path 指向单个文件时直接搜该文件（不再当目录抛 ENOTDIR）", async () => {
    const dir = setup();
    const file = path.join(dir, "single.txt");
    writeFileSync(file, "目标行 here");
    const out = await tool("grep").execute({ pattern: "目标行", path: file });
    expect(out).toContain("single.txt");
    expect(out).toContain("目标行 here");
  });

  it("grep path 不存在时返回可读提示（不抛 ENOENT 原始错误）", async () => {
    const dir = setup();
    const out = await tool("grep").execute({ pattern: "x", path: path.join(dir, "不存在目录") });
    expect(out).toContain("搜索路径不存在");
  });

  it("grep include 把反斜杠当路径分隔符（Windows 风格 src\\*.ts 不再静默不匹配）", async () => {
    const dir = setup();
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "a.ts"), "匹配行 xyz");
    writeFileSync(path.join(dir, "root.ts"), "匹配行 xyz");
    const out = await tool("grep").execute({ pattern: "xyz", path: dir, include: "src\\*.ts" });
    expect(out).toContain(path.join("src", "a.ts"));
    expect(out).not.toContain("root.ts");
  });

  it("grep 单文件路径同样应用 include 过滤（显式路径 + 不匹配时静默为空，rg 同款语义）", async () => {
    const dir = setup();
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "目标行 here");
    const out = await tool("grep").execute({ pattern: "目标行", path: file, include: "*.ts" });
    expect(out).toContain("未找到匹配内容");
  });

  it("grep limit 限制返回的匹配行数并在末尾标注截断", async () => {
    const dir = setup();
    writeFileSync(path.join(dir, "a.txt"), "x1\nx2\nx3\nx4");
    const out = await tool("grep").execute({ pattern: "x", path: dir, limit: 2 });
    expect(out).toContain("a.txt:1");
    expect(out).toContain("a.txt:2");
    expect(out).toContain("已达 limit 2");
    expect(out).not.toContain("a.txt:3");
  });

  it("grep limit 不小于匹配数时不截断、不加标注", async () => {
    const dir = setup();
    writeFileSync(path.join(dir, "a.txt"), "x1\nx2");
    const out = await tool("grep").execute({ pattern: "x", path: dir, limit: 10 });
    expect(out).toContain("a.txt:1");
    expect(out).toContain("a.txt:2");
    expect(out).not.toContain("limit");
  });

  it("grep 正则无效时返回可读错误不崩溃", async () => {
    const dir = setup();
    writeFileSync(path.join(dir, "a.txt"), "Hello world");
    const out = await tool("grep").execute({ pattern: "(?i)hello", path: dir });
    expect(out).toMatch(/正则无效/);
  });

  it("grep 多行全匹配（不跨行漏匹配）", async () => {
    const dir = setup();
    writeFileSync(path.join(dir, "a.txt"), "abc\nabc\nabc");
    const out = await tool("grep").execute({ pattern: "abc", path: dir });
    expect(out).toContain("a.txt:1");
    expect(out).toContain("a.txt:2");
    expect(out).toContain("a.txt:3");
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
