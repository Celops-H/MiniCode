import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile, parseEnvFile } from "../../src/config/index.js";

describe("parseEnvFile（.env 解析）", () => {
  it("解析 KEY=VALUE 行", () => {
    expect(parseEnvFile("DEEPSEEK_API_KEY=sk-123\nBASE_URL=https://api.example.com", {})).toEqual({
      DEEPSEEK_API_KEY: "sk-123",
      BASE_URL: "https://api.example.com",
    });
  });

  it("忽略 # 注释与空行", () => {
    expect(parseEnvFile("# 注释\n\nKEY=value\n# 另一行注释", {})).toEqual({ KEY: "value" });
  });

  it("支持 export 前缀", () => {
    expect(parseEnvFile("export API_KEY=abc", {})).toEqual({ API_KEY: "abc" });
  });

  it("剥离配对单双引号", () => {
    expect(parseEnvFile('A="hello"\nB=\'world\'', {})).toEqual({ A: "hello", B: "world" });
  });

  it("已有环境变量优先，.env 不覆盖", () => {
    expect(parseEnvFile("API_KEY=from-env\nNEW_KEY=added", { API_KEY: "existing" })).toEqual({
      NEW_KEY: "added",
    });
  });

  it("忽略无 = 号的行", () => {
    expect(parseEnvFile("JUST_WORDS\nKEY=value", {})).toEqual({ KEY: "value" });
  });
});

describe("loadEnvFile（读文件）", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("读取 .env 文件解析", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-env-"));
    const file = path.join(dir, ".env");
    writeFileSync(file, "API_KEY=sk-abc\n");
    expect(await loadEnvFile(file, {})).toEqual({ API_KEY: "sk-abc" });
  });

  it("文件不存在返回空对象", async () => {
    expect(await loadEnvFile("/nonexistent/.env", {})).toEqual({});
  });
});
