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

  it("未加引号值的行内注释剥 \" #\" 后缀（E88，标准 dotenv 语义）", () => {
    const vars = parseEnvFile('KEY=value # prod\nOTHER="a # b"\nQUOTED="x" # tail\n');
    expect(vars.KEY).toBe("value");
    // 引号内的 # 是内容，不剥
    expect(vars.OTHER).toBe("a # b");
    // 引号值后跟行内注释：先剥注释再剥引号
    expect(vars.QUOTED).toBe("x");
  });

  it("引号与注释组合形态不产出损坏值（E88 审查补充）", () => {
    const vars = parseEnvFile('K1="a # b" # tail' + String.fromCharCode(10) + "K2='ab # cd' # note" + String.fromCharCode(10) + 'K3="a" # "b"' + String.fromCharCode(10) + 'K4= # c' + String.fromCharCode(10) + 'K5=v#x' + String.fromCharCode(10));
    // 引号值内含 # 且后跟注释：不截断引号内内容、不残留引号
    expect(vars.K1).toBe("a # b");
    expect(vars.K2).toBe("ab # cd");
    // 注释以引号结尾：不误判整段为引号值
    expect(vars.K3).toBe("a");
    // = 后紧跟注释：空串
    expect(vars.K4).toBe("");
    // 无空格的 #：保留（密码含 # 更安全）
    expect(vars.K5).toBe("v#x");
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
