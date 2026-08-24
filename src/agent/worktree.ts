/**
 * Git Worktree 隔离（DESIGN 4.2/11.7）：并行 agent 各自独立工作区，
 * 文件写冲突从「提示重读重试」升级为物理隔离。
 * 仅 git 仓库场景有效（非 git 仓库退化为共享目录 + CAS 冲突防护）。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

/** Worktree 在仓库 .git 下的创建目录（不受 git 跟踪） */
const WORKTREE_REL = "minicode-worktrees";

/** 子 agent 分支名前缀（避免与用户分支混淆） */
const BRANCH_PREFIX = "minicode/";

/** worktree 自动提交使用的固定身份（不依赖用户 git 配置；仅用于 minicode 内部提交） */
const COMMIT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "minicode",
  GIT_AUTHOR_EMAIL: "minicode@local",
  GIT_COMMITTER_NAME: "minicode",
  GIT_COMMITTER_EMAIL: "minicode@local",
};

export interface WorktreeInfo {
  /** worktree 目录（子 agent 的 cwd） */
  dir: string;
  /** 子 agent 分支名（完成时合并回主分支） */
  branch: string;
}

/** 执行 git 命令，成功返回 stdout，失败返回 undefined（静默，非 git 仓库/命令失败） */
function git(repoDir: string, args: string[], env?: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * 检测目录所在 git 仓库根（git rev-parse --git-common-dir 的父目录）。
 * 主仓库与 worktree 都指向同一公共 .git 目录，故嵌套子 agent（cwd 在 worktree 内）
 * 也能正确解析到主仓库根。
 * @param cwd 目录
 * @returns 仓库根路径；非 git 仓库返回 undefined
 */
export function resolveGitRoot(cwd: string): string | undefined {
  const commonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (commonDir === undefined) return undefined;
  // common-dir 可能是相对 cwd 的路径（如 .git 或 .git/worktrees/x/..）
  return path.resolve(cwd, commonDir, "..");
}

/**
 * 为子 agent 创建独立 worktree：`git worktree add <dir> -b <branch>`，
 * 分支基于当前 HEAD（root 不提交，主分支始终无新提交，完成时可 fast-forward 合并）。
 * 残留同名 worktree 时创建失败返回 undefined（退化共享目录，不销毁「保留供人工处理」的成果）。
 * @param rootDir 主仓库根（root agent 的 git 根）
 * @param agentName 子 agent 名（分支名与目录名）
 * @returns worktree 信息；创建失败（非 git 仓库/同名残留）返回 undefined
 */
export function createWorktree(rootDir: string, agentName: string): WorktreeInfo | undefined {
  const branch = `${BRANCH_PREFIX}${agentName}`;
  const dir = path.join(rootDir, ".git", WORKTREE_REL, agentName);
  const ok = git(rootDir, ["worktree", "add", dir, "-b", branch]);
  return ok === undefined ? undefined : { dir, branch };
}

/** 合并结果：merged/no_changes 为终态（worktree 已清理）；kept 为保留态（目录/分支保留，可重试） */
export type WorktreeResult =
  | { status: "merged"; message: string }
  | { status: "no_changes"; message: string }
  | { status: "kept"; message: string };

/**
 * 子 agent 完成后合并其分支并清理 worktree。
 * 流程：判空 → 自动提交（固定 minicode 身份）→ 子 worktree 内合入主分支最新（三方合并，
 * 不重叠改动自动合并，冲突标记落在子 worktree——子 agent 的 cwd 直接可见，可自行解决）
 * → 快进合并回主分支 → 清理。
 * 冲突/失败保留 worktree 与分支（kept），子 agent 解决后再完成时本函数重跑即合并成功。
 * @param rootDir 主仓库根
 * @param info worktree 信息
 */
export function completeWorktree(rootDir: string, info: WorktreeInfo): WorktreeResult {
  // 先判空：子 agent 无改动时直接清理（区分「无改动」与「提交失败」，后者不得销毁产出）
  const dirty = git(info.dir, ["status", "--porcelain"]);
  if (dirty === "") {
    git(rootDir, ["worktree", "remove", "--force", info.dir]);
    git(rootDir, ["branch", "-D", info.branch]);
    return { status: "no_changes", message: "子 agent 无改动，无需合并" };
  }
  // 提交 worktree 改动（子 agent 的 write/edit 只落在工作区；固定 minicode 身份，不依赖用户配置）
  git(info.dir, ["add", "-A"]);
  const committed = git(info.dir, ["commit", "-m", `minicode: ${info.branch} 完成`], COMMIT_IDENTITY);
  if (committed === undefined) {
    // commit 失败（如 pre-commit hook 拒绝）：保留 worktree 与分支，改动不销毁
    return { status: "kept", message: `改动保留在分支 ${info.branch}（worktree ${info.dir}），请手动提交合并` };
  }
  // 子 worktree 内合入主分支最新（解决分叉）：三方合并，冲突标记落在子 worktree
  const mainBranch = git(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (mainBranch) {
    const merged = git(info.dir, ["merge", mainBranch, "--no-edit"], COMMIT_IDENTITY);
    if (merged === undefined) {
      // 冲突：保留 worktree（合并中状态），冲突文件在子 agent 的 cwd 可见，
      // 回灌父提示派子 agent 解决；解决后再次完成时本函数重跑即合并成功
      const conflicts = git(info.dir, ["diff", "--name-only", "--diff-filter=U"]) ?? "";
      return {
        status: "kept",
        message: `合并冲突（文件：${conflicts.split("\n").filter(Boolean).join("、")}）。请让子 agent 在其工作区解决冲突文件后提交，完成后会自动再次合并`,
      };
    }
  }
  // 子分支已含主分支最新：快进合并回主分支
  const ff = git(rootDir, ["merge", "--ff-only", info.branch], COMMIT_IDENTITY);
  if (ff === undefined) {
    git(rootDir, ["merge", "--abort"]); // 恢复主工作区，改动仍在分支上
    return { status: "kept", message: `改动保留在分支 ${info.branch}（worktree ${info.dir}），请手动合并` };
  }
  git(rootDir, ["worktree", "remove", "--force", info.dir]);
  git(rootDir, ["branch", "-D", info.branch]);
  return { status: "merged", message: "已合并进主分支" };
}

/**
 * 中断/废弃时清理 worktree 目录：先把未提交改动提交到分支（保留产出），再删目录。
 * 分支保留在仓库，后续 followup 复活时无需重新创建（中断不删 worktree 由调用方决定）。
 */
export function abortWorktree(rootDir: string, info: WorktreeInfo): void {
  // 冲突中（MERGE_HEAD 存在）先放弃合并：冲突标记是合并中间态，不该提交进分支
  // （review 修复：kept 保留 mid-merge worktree 后，中断/释放路径会走到这里）
  if (git(info.dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]) !== undefined) {
    git(info.dir, ["merge", "--abort"]);
  }
  git(info.dir, ["add", "-A"]);
  git(info.dir, ["commit", "-m", `minicode: ${info.branch} 中断提交`], COMMIT_IDENTITY);
  git(rootDir, ["worktree", "remove", "--force", info.dir]);
}