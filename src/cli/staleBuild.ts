/**
 * dist 过期检测与自动重建（E5）：用户日常用 minicode 启动的是 dist 构建产物，提交后忘记
 * 重建会拿过期产物测试新功能（历史 bug：箭头残留、模型选中无高亮均由此起）。启动时比较
 * dist 最新文件修改时间与最近一次提交时间，dist 过期则自动 pnpm build 后再进入界面。
 * 仅对 dist 产物运行生效（import.meta.url 不在 dist 下即源码直跑，跳过）；非 git 仓库
 * （全局安装）或 git 不可用时静默跳过，不影响正常启动。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 从模块 URL 解析项目根（dist 产物运行时）：取路径中最后一个 dist 段的上一级。
 * 源码直跑（路径无 dist 段，如 tsx src/cli/app.ts）返回 undefined——调用方跳过检测。
 * @param moduleUrl 当前模块的 import.meta.url
 * @returns 项目根目录；非 dist 运行返回 undefined
 */
export function findDistRoot(moduleUrl: string): string | undefined {
  const filePath = path.resolve(fileURLToPath(moduleUrl));
  const segments = filePath.split(path.sep);
  const distIdx = segments.lastIndexOf("dist");
  if (distIdx <= 0) return undefined;
  return segments.slice(0, distIdx).join(path.sep);
}

/**
 * 过期判定（纯函数）：构建产物时间早于最近提交即过期。
 * @param lastCommitMs 最近提交时刻（ms）；undefined = 无法取得（非 git 仓库等）
 * @param buildMs dist 最新文件修改时刻（ms）；undefined = 无法取得（dist 缺失等）
 * @returns true 过期 / false 未过期 / undefined 无法判定（调用方跳过）
 */
export function isStaleBuild(
  lastCommitMs: number | undefined,
  buildMs: number | undefined,
): boolean | undefined {
  if (lastCommitMs === undefined || buildMs === undefined) return undefined;
  return lastCommitMs > buildMs;
}

/**
 * 最近一次提交时刻（ms）：git log -1 --format=%ct。非 git 仓库、git 不可用或命令失败
 * 返回 undefined（静默跳过检测，启动不被阻断）。
 * @param root 项目根（git 命令的工作目录）
 * @returns 提交时刻毫秒；无法判定返回 undefined
 */
export async function lastCommitTime(root: string): Promise<number | undefined> {
  if (!existsSync(path.join(root, ".git"))) return undefined;
  return new Promise((resolve) => {
    const child = spawn("git", ["log", "-1", "--format=%ct"], { cwd: root });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      const seconds = Number.parseInt(out.trim(), 10);
      resolve(code === 0 && Number.isFinite(seconds) ? seconds * 1000 : undefined);
    });
  });
}

/**
 * dist 目录最新文件修改时刻（ms）：递归取全部文件 mtime 最大值。tsc 增量编译只改写变化
 * 文件，单看某个文件不可靠，取整树最新值——pnpm build 的 tsc 与 vite 两步都有产物刷新。
 * @param distDir dist 目录
 * @returns 最新 mtime（ms）；目录不存在或无文件返回 undefined
 */
export async function newestBuildTime(distDir: string): Promise<number | undefined> {
  if (!existsSync(distDir)) return undefined;
  const entries = await fsp.readdir(distDir, { recursive: true, withFileTypes: true });
  let newest: number | undefined;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const stat = await fsp.stat(path.join(entry.parentPath ?? distDir, entry.name));
      newest = newest === undefined ? stat.mtimeMs : Math.max(newest, stat.mtimeMs);
    } catch {
      // 个别文件 stat 失败（构建竞态删除）跳过，不阻断判定
    }
  }
  return newest;
}

/**
 * 执行 pnpm build（stdio 直通让用户看到构建进度）。
 * @param root 项目根（构建命令工作目录）
 * @returns 构建成功 true；命令失败（含 pnpm 不存在）false
 */
export function runBuild(root: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Windows 的 pnpm 是 .cmd，需经 shell 解析；其余平台直跑
    const child = spawn("pnpm", ["build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * 启动前置检测入口：dist 过期则自动重建（阻塞至构建完成后继续启动）。
 * 判定所需的任一前提不成立（源码直跑 / 非 git 环境 / dist 缺失）都静默跳过；
 * 自动构建失败不阻断启动，提示后继续用现有产物。
 * @param moduleUrl 调用方模块 URL（判定是否 dist 运行）；缺省用本模块（编译后在 dist 下）
 */
export async function rebuildIfStale(moduleUrl: string = import.meta.url): Promise<void> {
  const root = findDistRoot(moduleUrl);
  if (!root) return;
  const [commitMs, buildMs] = await Promise.all([
    lastCommitTime(root),
    newestBuildTime(path.join(root, "dist")),
  ]);
  if (isStaleBuild(commitMs, buildMs) !== true) return;
  console.error("检测到 dist 构建产物早于最近提交，正在重新构建（pnpm build），请稍候…");
  const ok = await runBuild(root);
  if (!ok) {
    console.error("自动构建失败：继续用现有 dist 产物启动，可手动执行 pnpm build 后重试");
  }
}
