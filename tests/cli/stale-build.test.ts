/**
 * dist 过期检测与自动重建（E5）测试：纯函数（findDistRoot / isStaleBuild）与文件系统
 * 部分（newestBuildTime）；git 命令包装与 pnpm build 执行是薄 IO 层，随真机验证。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findDistRoot, isStaleBuild, newestBuildTime } from "../../src/cli/staleBuild.js";
import { pathToFileURL } from "node:url";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("findDistRoot（dist 运行判定）", () => {
  it("dist 下的模块 URL 解析出项目根（dist 的上一级）", () => {
    const root = findDistRoot(pathToFileURL(path.join("x:", "proj", "dist", "cli", "staleBuild.js").replace("x:", process.platform === "win32" ? "X:" : "")).href);
    // Windows 盘符大小写经 path.resolve 规范化，只断言以 dist 截断的结构
    expect(root).toBeDefined();
    expect(root!.endsWith(path.join("proj")) || root!.endsWith(path.sep + "proj") || path.basename(root!) === "proj").toBe(true);
  });

  it("源码直跑（路径无 dist 段）返回 undefined：跳过检测", () => {
    expect(findDistRoot(pathToFileURL(path.resolve(os.tmpdir(), "proj", "src", "cli", "app.ts")).href)).toBeUndefined();
  });
});

describe("isStaleBuild（过期判定真值表）", () => {
  it("构建时间早于最近提交 → 过期（true）", () => {
    expect(isStaleBuild(2000, 1000)).toBe(true);
  });

  it("构建时间晚于等于最近提交 → 未过期（false）", () => {
    expect(isStaleBuild(1000, 2000)).toBe(false);
    expect(isStaleBuild(1000, 1000)).toBe(false);
  });

  it("任一时刻无法取得（undefined）→ 无法判定（undefined，调用方跳过）", () => {
    expect(isStaleBuild(undefined, 1000)).toBeUndefined();
    expect(isStaleBuild(1000, undefined)).toBeUndefined();
    expect(isStaleBuild(undefined, undefined)).toBeUndefined();
  });
});

describe("newestBuildTime（dist 最新文件 mtime）", () => {
  it("递归取全部文件 mtime 最大值", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mc-stale-"));
    dirs.push(dir);
    const sub = path.join(dir, "cli");
    mkdirSync(sub);
    writeFileSync(path.join(dir, "a.js"), "x");
    writeFileSync(path.join(sub, "b.js"), "y");
    const old = new Date(Date.now() - 60_000);
    const newer = new Date();
    utimesSync(path.join(dir, "a.js"), old, old);
    utimesSync(path.join(sub, "b.js"), newer, newer);
    const newest = await newestBuildTime(dir);
    expect(newest).toBeDefined();
    // 最大值取到较新的 b.js（与 old 差 60s，容差断言避免时钟精度问题）
    expect(newest! > Date.now() - 10_000).toBe(true);
  });

  it("目录不存在返回 undefined", async () => {
    expect(await newestBuildTime(path.join(os.tmpdir(), "mc-stale-nonexist"))).toBeUndefined();
  });
});
