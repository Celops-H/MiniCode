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

/** 空转模型客户端（只回一句正文，不调工具） */
function emptyClient(): ModelClient {
  return {
    async *stream() {
      yield { type: "text_delta", text: "ok" };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
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
  maxResultSizeChars: 100,
  execute: async (input: { path: string; content: string }) => {
    const { resolvePath } = await import("../../src/tools/file-state.js");
    const { writeFile } = await import("node:fs/promises");
    const file = resolvePath(input.path);
    await writeFile(file, input.content, "utf8");
    return `已写入 ${file}`;
  },
};

/** 按任务序列工作的 mock：每次新任务写对应文件，下一 turn 返回「写完」结束（turn 计数，不受历史 tool_result 影响） */
function sequenceClient(tasks: Array<{ file: string; content: string }>): ModelClient {
  let turn = 0;
  return {
    async *stream(_modelId, _context) {
      const task = tasks[turn >> 1];
      if (!task) {
        yield { type: "text_delta", text: "没任务了" };
        yield { type: "done", stopReason: "end_turn" };
        return;
      }
      if (turn % 2 === 0) {
        // 新任务：写文件（偶数 turn）
        yield { type: "toolcall_start", index: 0, id: "c1", name: "write" };
        yield {
          type: "toolcall_delta",
          index: 0,
          partialJson: JSON.stringify({ path: task.file, content: task.content }),
        };
        yield { type: "toolcall_end", index: 0 };
        yield { type: "done", stopReason: "tool_calls" };
      } else {
        // 任务完成：汇报（奇数 turn）
        yield { type: "text_delta", text: "写完了" };
        yield { type: "done", stopReason: "end_turn" };
      }
      turn++;
    },
  };
}

/**
 * 派生一次即收尾的 mock：第一轮 spawn_agent（按传入参数），之后所有轮回正文。
 * 子 agent 复用同实例（靠上下文里的系统注入消息区分）：等到 gate 放行才回正文，
 * 让测试能在子 agent 完成前断言 worktree 挂载状态（完成即合并清理，来不及看）。
 */
function spawnOnceClient(spawnInput: Record<string, unknown>, childGate?: Promise<void>): ModelClient {
  let spawned = false;
  return {
    async *stream(_modelId, context) {
      if (!spawned) {
        spawned = true;
        yield { type: "toolcall_start", index: 0, id: "c1", name: "spawn_agent" };
        yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify(spawnInput) };
        yield { type: "toolcall_end", index: 0 };
        yield { type: "done", stopReason: "tool_calls" };
        return;
      }
      const isChild = context.messages.some((m) => m.role === "user" && m.source === "system");
      if (isChild && childGate) await childGate;
      yield { type: "text_delta", text: "完成" };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

describe("Git Worktree 隔离", () => {
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
    const worktree = team.createChildWorktree(AgentPath.parse("/root/worker") as AgentPath);
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
    const worktree = team.createChildWorktree(AgentPath.parse("/root/worker") as AgentPath);
    expect(worktree).toBeUndefined();
  });

  it("不同父下同名子 agent：目录/分支名掺完整路径，两者都创建成功不撞名", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    initGitRepo(dir);
    const a = createWorktree(dir, "/root/t1/worker")!;
    const b = createWorktree(dir, "/root/t2/worker")!;
    expect(a.dir).not.toBe(b.dir);
    expect(a.branch).not.toBe(b.branch);
    expect(a.branch).toContain("t1-worker");
    expect(b.branch).toContain("t2-worker");
    expect(existsSync(a.dir)).toBe(true);
    expect(existsSync(b.dir)).toBe(true);
  });

  it("分支残留时复用建 worktree：中断保留的分支不再让同名派生永久退化", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    initGitRepo(dir);
    const first = createWorktree(dir, "/root/worker")!;
    writeFileSync(path.join(first.dir, "产出.txt"), "上次的部分产出");
    // 模拟中断保留场景：产出提交进分支，目录删除、分支保留（abortWorktree 的行为）
    execSync("git add -A && git commit -qm work", { cwd: first.dir });
    execSync(`git worktree remove --force "${first.dir}"`, { cwd: dir });
    expect(existsSync(first.dir)).toBe(false);

    // 同名再派生：复用残留分支成功创建（旧实现 -b 重复建分支直接失败）
    const second = createWorktree(dir, "/root/worker")!;
    expect(second.branch).toBe(first.branch);
    expect(existsSync(second.dir)).toBe(true);
    // 复用的分支带着上次的部分产出（与「保留供人工处理」语义一致）
    expect(existsSync(path.join(second.dir, "产出.txt"))).toBe(true);
  });

  it("逐次开关：派生时显式关闭/开启覆盖 Team 全局缺省", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    initGitRepo(dir);
    const teamOn = new Team({ worktrees: true });
    const rootOn = new Agent({
      modelClient: emptyClient(),
      modelId: "mock",
      systemPrompt: "助手",
      cwd: dir,
      tools: [],
      team: teamOn,
    });
    teamOn.registerRoot(rootOn);
    // 全局开、派生时显式关：不创建
    expect(teamOn.createChildWorktree(AgentPath.parse("/root/worker") as AgentPath, false)).toBeUndefined();
    // 全局开、不传：随全局创建
    expect(teamOn.createChildWorktree(AgentPath.parse("/root/worker") as AgentPath)).toBeDefined();

    const teamOff = new Team({ worktrees: false });
    const rootOff = new Agent({
      modelClient: emptyClient(),
      modelId: "mock",
      systemPrompt: "助手",
      cwd: dir,
      tools: [],
      team: teamOff,
    });
    teamOff.registerRoot(rootOff);
    // 全局关、派生时显式开：创建（换一个子路径，避开上面 teamOn 已占用的同名 worktree）
    expect(teamOff.createChildWorktree(AgentPath.parse("/root/other") as AgentPath, true)).toBeDefined();
    // 全局缺省值经 getter 暴露（spawn 工具 worktree 参数缺省随它）
    expect(teamOff.worktreeDefault).toBe(false);
    expect(teamOn.worktreeDefault).toBe(true);
  });

  it("spawn_agent 接线：全局开关关闭时模型显式 worktree:true，子 agent 仍落独立 worktree", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    initGitRepo(dir);
    // 全局关：隔离完全靠派生时的 worktree 参数逐次选择（会写文件的任务开启）
    const team = new Team({ worktrees: false });
    // 子 agent 等门控放行才收尾：完成即合并清理，必须趁挂着时断言
    let releaseChild: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const root = new Agent({
      modelClient: spawnOnceClient({ agentName: "worker", prompt: "写文件", worktree: true }, gate),
      modelId: "mock",
      systemPrompt: "助手",
      cwd: dir,
      tools: [writeTool],
      team,
    });
    team.registerRoot(root);
    root.start("派活");
    for await (const _ of root.run()) {
      // 消费
    }
    const member = team.resolveAgent(AgentPath.parse("/root/worker") as AgentPath);
    expect(member?.agent).toBeDefined();
    // 隔离生效：spawn 结果不带退化注明，子 agent cwd 在独立 worktree
    const result = root.getMessages().find((m) => m.role === "tool_result");
    expect(String(result?.content)).toContain("已派生 /root/worker");
    expect(String(result?.content)).not.toContain("未生效");
    expect(member?.worktree).toBeDefined();
    expect(member!.agent!.getCwd()).toContain("root-worker");
    // 放行后子 agent 自然完成：worktree 合并回主工作区并清理
    //（轮询等待：git 清理链条耗时不确定，固定 sleep 在负载下会误报）
    const worktreeDir = member!.worktree!.dir;
    releaseChild();
    await expect
      .poll(() => member?.worktree, { interval: 20, timeout: 10_000 })
      .toBeUndefined();
    expect(existsSync(worktreeDir)).toBe(false);
  });

  it("spawn_agent 接线：全局开启但非 git 仓库，spawn 结果注明隔离未生效并退化共享父目录", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    const team = new Team({ worktrees: true });
    const root = new Agent({
      modelClient: spawnOnceClient({ agentName: "worker", prompt: "写文件" }),
      modelId: "mock",
      systemPrompt: "助手",
      cwd: dir,
      tools: [writeTool],
      team,
    });
    team.registerRoot(root);
    root.start("派活");
    for await (const _ of root.run()) {
      // 消费
    }
    const member = team.resolveAgent(AgentPath.parse("/root/worker") as AgentPath);
    expect(member?.agent).toBeDefined();
    // 非 git 仓库：子 agent 退化继承父 cwd
    expect(member!.agent!.getCwd()).toBe(dir);
    const result = root.getMessages().find((m) => m.role === "tool_result");
    expect(String(result?.content)).toContain("worktree 隔离未生效");
    await new Promise((resolve) => setTimeout(resolve, 200));
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
    const first = team.createChildWorktree(AgentPath.parse("/root/worker") as AgentPath);
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
    const second = team.createChildWorktree(AgentPath.parse("/root/worker/grand") as AgentPath);
    expect(second).toBeDefined();
    expect(second!.dir).toContain(".git");
    expect(second!.dir).not.toBe(first!.dir);
  });

  it("Team 集成：冲突后 member.worktree 保留，子 agent 解决冲突再完成即合并成功（原实现无条件清空断送重试）", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    initGitRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "第一行\n第二行\n第三行\n");
    execSync("git add -A && git commit -qm second", { cwd: dir });

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

    // A、B 同时派生（同一 base），改同一行（冲突）
    const spawnChild = (name: string, client: ModelClient) => {
      const childPath = team.reserveSpawn(AgentPath.root(), name) as AgentPath;
      const worktree = team.createChildWorktree(AgentPath.parse(`/root/${name}`) as AgentPath)!;
      const child = new Agent({
        modelClient: client,
        modelId: "mock",
        systemPrompt: "助手",
        cwd: worktree.dir,
        tools: [writeTool],
        team,
      });
      team.commitSpawn(childPath, child);
      return { childPath, worktree, child };
    };
    const a = spawnChild("agent_a", sequenceClient([{ file: "a.txt", content: "A 的版本\n第二行\n第三行\n" }]));
    const b = spawnChild("agent_b", sequenceClient([{ file: "a.txt", content: "B 的版本\n第二行\n第三行\n" }, { file: "from-b.txt", content: "B 后续数据" }]));

    // A 先完成：合并成功
    await team.sendMessage(a.childPath, { type: "NEW_TASK", from: AgentPath.root(), content: "写文件", triggerTurn: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toContain("A 的版本");
    expect(existsSync(a.worktree.dir)).toBe(false);

    // B 完成：冲突，worktree 保留（不再被 Team 清空断送重试）
    await team.sendMessage(b.childPath, { type: "NEW_TASK", from: AgentPath.root(), content: "写文件", triggerTurn: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(b.worktree.dir)).toBe(true);
    expect(team.resolveAgent(b.childPath)?.worktree).toBeDefined();
    const conflictFile = await readFile(path.join(b.worktree.dir, "a.txt"), "utf8");
    expect(conflictFile).toContain("<<<<<<<");

    // 子 agent 解决冲突（编辑冲突文件为最终版本）后再完成：合并成功、worktree 清理
    writeFileSync(path.join(b.worktree.dir, "a.txt"), "最终合并版本\n第二行\n第三行\n");
    await team.sendMessage(b.childPath, { type: "NEW_TASK", from: AgentPath.root(), content: "继续", triggerTurn: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toContain("最终合并版本");
    expect(await readFile(path.join(dir, "from-b.txt"), "utf8")).toBe("B 后续数据");
    expect(existsSync(b.worktree.dir)).toBe(false);
    expect(team.resolveAgent(b.childPath)?.worktree).toBeUndefined();
    // 全量并发负载下真实 git 合并链条偶发超 5s 默认超时：单独跑稳定 ~1s，放宽到 20s
  }, 20_000);

  it("子 agent 无改动：判空分支直接清理（不误报合并）", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    initGitRepo(dir);
    const info = createWorktree(dir, "/root/worker")!;
    // 子 agent 什么都没改
    const result = completeWorktree(dir, info);
    expect(result.status).toBe("no_changes");
    expect(result.message).toContain("无改动");
    expect(existsSync(info.dir)).toBe(false);
  });

  it("commit 真实失败（pre-commit hook 拒绝）时产出保留：不误判「无改动」销毁", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wt-"));
    initGitRepo(dir);
    // 仓库 pre-commit hook 拒绝提交（模拟 commit 真实失败）
    writeFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
    const info = createWorktree(dir, "/root/worker")!;
    // 子 agent 在 worktree 里写文件
    writeFileSync(path.join(info.dir, "output.txt"), "产出数据");

    const result = completeWorktree(dir, info);
    // 不被误判为「无改动」：产出保留在 worktree、目录未销毁
    expect(result.status).toBe("kept");
    expect(result.message).toContain("保留");
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
    const infoA = createWorktree(dir, "/root/agent_a")!;
    const infoB = createWorktree(dir, "/root/agent_b")!;
    writeFileSync(path.join(infoA.dir, "a.txt"), "A 改第一行\n第二行\n第三行\n");
    const msgA = completeWorktree(dir, infoA);
    expect(msgA.status).toBe("merged");

    writeFileSync(path.join(infoB.dir, "a.txt"), "第一行\n第二行\nB 改第三行\n");
    const msgB = completeWorktree(dir, infoB);
    expect(msgB.status).toBe("merged");
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
    const infoA = createWorktree(dir, "/root/agent_a")!;
    const infoB = createWorktree(dir, "/root/agent_b")!;
    writeFileSync(path.join(infoA.dir, "a.txt"), "A 的版本\n第二行\n第三行\n");
    const msgA = completeWorktree(dir, infoA);
    expect(msgA.status).toBe("merged");

    writeFileSync(path.join(infoB.dir, "a.txt"), "B 的版本\n第二行\n第三行\n");
    const msgB = completeWorktree(dir, infoB);
    expect(msgB.status).toBe("kept");
    expect(msgB.message).toContain("合并冲突");
    expect(msgB.message).toContain("a.txt");
    // 冲突时 worktree 保留（合并中状态），冲突文件在子 agent cwd 可见
    expect(existsSync(infoB.dir)).toBe(true);
    const conflictFile = await readFile(path.join(infoB.dir, "a.txt"), "utf8");
    expect(conflictFile).toContain("<<<<<<<");

    // 子 agent 解决冲突：编辑冲突文件为最终版本
    writeFileSync(path.join(infoB.dir, "a.txt"), "最终合并版本\n第二行\n第三行\n");
    const msgB2 = completeWorktree(dir, infoB);
    expect(msgB2.status).toBe("merged");
    // 主工作区得到最终版本，worktree 清理
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toContain("最终合并版本");
    expect(existsSync(infoB.dir)).toBe(false);
  });
});