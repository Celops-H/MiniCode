/**
 * 层 1：底栏 agent 树（P1-5）——main 仅多 agent 显示、子 agent ( )/(√)+耗时、树线对齐括号中心列、10s 消失。
 */
import { testRender } from "@opentui/solid";
import { it, expect } from "vitest";
import { AgentStrip } from "../../src/tui/view/AgentStrip.js";
import type { AgentNode } from "../../src/tui/state.js";

const running = (path: string, spawnedAt: number | null = null): AgentNode => ({
  path,
  status: "running",
  spawnedAt,
  completedAt: null,
});
const done = (path: string, spawnedAt: number, completedAt: number): AgentNode => ({
  path,
  status: "completed",
  spawnedAt,
  completedAt,
});

const render = (agents: AgentNode[]) =>
  testRender(() => <AgentStrip agents={agents} />, { width: 40, height: 10 });

it("仅 main（无子 agent）不显示底栏——main 只多 agent 启用时出现", async () => {
  const setup = await render([running("/root")]);
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).not.toContain("main");
});

it("子 agent 运行中显示 ( ) 名称，main() 在首行", async () => {
  const setup = await render([running("/root"), running("/root/task_1")]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("● main()");
  expect(frame).toContain("( ) task_1");
});

it("子 agent 完成显示 (√) 名称 耗时", async () => {
  const t = Date.now();
  const setup = await render([running("/root"), done("/root/task_1", t - 3000, t)]);
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("(√) task_1 3s");
});

it("完成超 10s 的条目从树消失（回到仅 main → 底栏不显示）", async () => {
  const t = Date.now();
  const setup = await render([running("/root"), done("/root/task_1", t - 20_000, t - 10_000)]);
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).not.toContain("task_1");
  expect(setup.captureCharFrame()).not.toContain("main");
});

it("树线对齐父括号中心列：├─/└─ 放 main 括号列、子层 │ 对齐父 ( ) 括号中心", async () => {
  const t = Date.now();
  const setup = await render([
    running("/root"),
    running("/root/task_1"),
    done("/root/task_1/sub", t - 2000, t),
    done("/root/task_2", t - 1000, t),
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  const mainLine = lines.find((l) => l.includes("● main()")) ?? "";
  const t1 = lines.find((l) => l.includes("( ) task_1")) ?? "";
  const t2 = lines.find((l) => l.includes("(√) task_2")) ?? "";
  const sub = lines.find((l) => l.includes("(√) sub")) ?? "";
  // main 括号列（● main() 的 `(`，AgentStrip paddingX=1 后实际列）
  const mainParenCol = mainLine.indexOf("(");
  // 子行连接线 ├─/└─ 放 main 括号列（层级竖线对齐父括号中心列）
  expect(t1.indexOf("├")).toBe(mainParenCol);
  expect(t2.indexOf("└")).toBe(mainParenCol);
  // task_1 括号中心列 = ( ) 中间空格列
  const t1Center = t1.indexOf("(") + 1;
  // sub 行：│ 在 main 括号列（main 还有 task_2 兄弟）、└ 在 task_1 括号中心列
  expect(sub[mainParenCol]).toBe("│");
  expect(sub.indexOf("└")).toBe(t1Center);
});
