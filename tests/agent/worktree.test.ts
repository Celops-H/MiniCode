import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, AgentPath, Team, type ModelClient } from "../../src/agent/index.js";
import { completeWorktree, createWorktree } from "../../src/agent/worktree.js";

/** 初始化一个 git 仓库并提交初始文件 */
function initGitRepo(dir: string): void {
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  execSync("git add . && git commit -qm init", { cwd: dir });
}

/** spawn 工具的 mock：子 agent 第一轮写文件到 cwd，第二轮总结 */
function workerClient(fileName: string): ModelClient {
  return {
    async *stream(_modelId, context) {
      const hasResult = context.messages.some((m) => m.role === "tool_result");
      if (!hasResult) {
        yield { type: "toolcall_start", index: 0, id: "c1", name: "write" };
        yield {
          type: "toolcall_delta",
          index: 0,
          partialJson: JSON.stringify({ path: fileName, content: "子 agent 数据" }),
        };
        yield { type: "toolcall_end", index: 0 };
        yield { type: "done", stopReason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: "写完了" };
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
}

/** 写文件工具（相对路径基于工具上下文 cwd 解析） */
const writeTool = {
  name: "write",
  description: "写入文件",
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  isReadOnly: false,
  requiresUserInteraction: false,
  maxResultSizeChars: 100,
  execute: async (input: { path: string; content: string }) => {
    const { resolvePath } = await import("../../src/tools/file-state.js");
    const { writeFile } = await import("node:fs/promises");
    const file = resolvePath(input.path);
    await writeFile(file, input.content, "utf8");
    return `已写入 ${file}`;
  },
};

describe("Git Worktree 隔离（DESIGN 4.2/11.7）", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("端到端：spawn 创建独立 worktree → 子 agent 在独立目录写文件 → 完成时合并回主工作区并清理", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    initGitRepo(dir);

    const team = new Team({ worktrees: true });
    const root = new Agent({
      modelClient: {
        async *stream() {
          yield { type: "text_delta", text: "收到结论" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      cwd: dir,
      tools: [],
      team,
    });
    team.registerRoot(root);

    // 手工组装 spawn 流程（等价 spawn_agent 工具执行路径）
    const childPath = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    // createChildAgent 内做 worktree 创建——手工路径用等价逻辑：
    // 直接验证 Team.createChildWorktree + child cwd 绑定
    const worktree = team.createChildWorktree(AgentPath.root(), "worker");
    expect(worktree).toBeDefined();
    expect(worktree!.dir).not.toBe(dir); // 独立目录
    expect(worktree!.dir).toContain(".git"); // 建在仓库 .git 下（不受跟踪）

    // 子 agent 绑定 worktree cwd 后驱动干活
    const child = new Agent({
      modelClient: workerClient("from-worker.txt"),
      modelId: "mock",
      systemPrompt: "助手",
      cwd: worktree!.dir,
      tools: [writeTool],
      team,
    });
    team.commitSpawn(childPath, child);
    await team.sendMessage(childPath, {
      type: "NEW_TASK",
      from: AgentPath.root(),
      content: "写文件",
      triggerTurn: true,
    });
    // 等子 agent 干完（后台驱动）
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 子 agent 完成后 worktree 已合并进主工作区（文件出现在 root 的 cwd），worktree 目录已清理
    expect(await readFile(path.join(dir, "from-worker.txt"), "utf8")).toBe("子 agent 数据");
    expect(existsSync(worktree!.dir)).toBe(false);
    // 结论回灌父（含合并提示，FINAL_ANSWER 以 system 注入父上下文）
    const result = root
      .getMessages()
      .find((m) => m.role === "user" && m.source === "system" && m.content.includes("结论"));
    expect(String(result?.content)).toContain("已合并进主分支");
  });

  it("非 git 仓库：worktrees 配置被忽略（不创建、不报错）", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    const team = new Team({ worktrees: true });
    const root = new Agent({
      modelClient: {
        async *stream() {
          yield { type: "text_delta", text: "ok" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      cwd: dir,
      tools: [],
      team,
    });
    team.registerRoot(root);
    const worktree = team.createChildWorktree(AgentPath.root(), "worker");
    expect(worktree).toBeUndefined();
  });

  it("嵌套（深度 2）：子 agent 的 worktree 内再派生孙 agent，根解析正确、隔离链不退化", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    initGitRepo(dir);

    const team = new Team({ worktrees: true });
    const root = new Agent({
      modelClient: {
        async *stream() {
          yield { type: "text_delta", text: "ok" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      cwd: dir,
      tools: [],
      team,
    });
    team.registerRoot(root);

    // 第一层 worktree（worker）
    const first = team.createChildWorktree(AgentPath.root(), "worker");
    expect(first).toBeDefined();
    // worker 注册进团队（其 cwd = worktree 目录）
    const firstPath = team.reserveSpawn(AgentPath.root(), "worker") as AgentPath;
    const worker = new Agent({
      modelClient: {
        async *stream() {
          yield { type: "text_delta", text: "ok" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      cwd: first!.dir,
      tools: [],
      team,
    });
    team.commitSpawn(firstPath, worker);
    // worker 在 worktree 内再派生孙 agent：其 cwd 在 worktree 中，根应解析到主仓库
    const second = team.createChildWorktree(firstPath, "grand");
    expect(second).toBeDefined();
    expect(second!.dir).toContain(".git");
    expect(second!.dir).not.toBe(first!.dir);
  });

  it("子 agent 无改动：判空分支直接清理（不误报合并）", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    initGitRepo(dir);
    const info = createWorktree(dir, "worker")!;
    // 子 agent 什么都没改
    const message = completeWorktree(dir, info);
    expect(message).toContain("无改动");
    expect(existsSync(info.dir)).toBe(false);
  });

  it("commit 真实失败（pre-commit hook 拒绝）时产出保留：不误判「无改动」销毁（review 阻断修复）", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    initGitRepo(dir);
    // 仓库 pre-commit hook 拒绝提交（模拟 commit 真实失败）
    writeFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
    const info = createWorktree(dir, "worker")!;
    // 子 agent 在 worktree 里写文件
    writeFileSync(path.join(info.dir, "output.txt"), "产出数据");

    const message = completeWorktree(dir, info);
    // 不被误判为「无改动」：产出保留在 worktree、目录未销毁
    expect(message).toContain("保留");
    expect(existsSync(info.dir)).toBe(true);
    expect(await readFile(path.join(info.dir, "output.txt"), "utf8")).toBe("产出数据");
  });

  it("多个子 agent 改同一文件不同位置：三方合并自动解决，两个都成功", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    initGitRepo(dir);
    // 初始文件两行
    writeFileSync(path.join(dir, "a.txt"), "第一行\n第二行\n第三行\n");
    execSync("git add -A && git commit -qm second", { cwd: dir });

    // A、B 同时派生（同一 base）：A 改第 1 行、B 改第 3 行（同一文件不同位置）
    const infoA = createWorktree(dir, "agent_a")!;
    const infoB = createWorktree(dir, "agent_b")!;
    writeFileSync(path.join(infoA.dir, "a.txt"), "A 改第一行\n第二行\n第三行\n");
    const msgA = completeWorktree(dir, infoA);
    expect(msgA).toContain("已合并进主分支");

    writeFileSync(path.join(infoB.dir, "a.txt"), "第一行\n第二行\nB 改第三行\n");
    const msgB = completeWorktree(dir, infoB);
    expect(msgB).toContain("已合并进主分支");
    // 两处改动都在（自动三方合并）
    const final = await readFile(path.join(dir, "a.txt"), "utf8");
    expect(final).toContain("A 改第一行");
    expect(final).toContain("B 改第三行");
  });

  it("同一位置冲突：冲突标记落在子 worktree，子 agent 解决后再次完成即合并成功", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    initGitRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "第一行\n第二行\n第三行\n");
    execSync("git add -A && git commit -qm second", { cwd: dir });

    // A、B 同时派生（同一 base），改同一行（冲突）
    const infoA = createWorktree(dir, "agent_a")!;
    const infoB = createWorktree(dir, "agent_b")!;
    writeFileSync(path.join(infoA.dir, "a.txt"), "A 的版本\n第二行\n第三行\n");
    const msgA = completeWorktree(dir, infoA);
    expect(msgA).toContain("已合并进主分支");

    writeFileSync(path.join(infoB.dir, "a.txt"), "B 的版本\n第二行\n第三行\n");
    const msgB = completeWorktree(dir, infoB);
    expect(msgB).toContain("合并冲突");
    expect(msgB).toContain("a.txt");
    // 冲突时 worktree 保留（合并中状态），冲突文件在子 agent cwd 可见
    expect(existsSync(infoB.dir)).toBe(true);
    const conflictFile = await readFile(path.join(infoB.dir, "a.txt"), "utf8");
    expect(conflictFile).toContain("<<<<<<<");

    // 子 agent 解决冲突：编辑冲突文件为最终版本
    writeFileSync(path.join(infoB.dir, "a.txt"), "最终合并版本\n第二行\n第三行\n");
    const msgB2 = completeWorktree(dir, infoB);
    expect(msgB2).toContain("已合并进主分支");
    // 主工作区得到最终版本，worktree 清理
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toContain("最终合并版本");
    expect(existsSync(infoB.dir)).toBe(false);
  });
});