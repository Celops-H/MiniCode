/**
 * 层 1：底栏 agent 树（P1-5）——main 仅多 agent 显示、子 agent ( )/(√)+耗时、树线对齐父圆点/括号中心列、10s 消失。
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

it("子 agent 运行中显示 ( ) 名称，main 在首行不带括号", async () => {
  const setup = await render([running("/root"), running("/root/task_1")]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("● main");
  expect(frame).not.toContain("main()");
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

it("完成父被剪（超 10s）时运行中的子 agent 重挂最近存活祖先不失联", async () => {
  const t = Date.now();
  // task_1 完成超 10s 被剪，但其下 sub 仍运行 → sub 重挂到 /root 继续显示
  const setup = await render([
    running("/root"),
    done("/root/task_1", t - 30_000, t - 20_000),
    running("/root/task_1/sub"),
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("● main");
  expect(frame).toContain("( ) sub"); // 运行中子仍显示
  expect(frame).not.toContain("task_1"); // 完成父消失
  // sub 重挂为 main 直接子级（唯一子级 → └ 连接线对齐 main 圆点列）
  const mainLine = frame.split("\n").find((l) => l.includes("● main")) ?? "";
  const sub = frame.split("\n").find((l) => l.includes("( ) sub")) ?? "";
  expect(sub.indexOf("└")).toBe(mainLine.indexOf("●"));
});

it("中断 (×) 名称 显示且 10s 后消失", async () => {
  const t = Date.now();
  // 中断条目 loop 侧注入 completedAt（与完成同路径），10s 内显示 (×)
  const recent: AgentNode = { path: "/root/task_1", status: "interrupted", spawnedAt: t - 5000, completedAt: t - 1000 };
  const setup = await render([running("/root"), recent]);
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("(×) task_1");
  // 中断超 10s 消失
  const past: AgentNode = { path: "/root/task_2", status: "interrupted", spawnedAt: t - 20_000, completedAt: t - 10_000 };
  const setup2 = await render([running("/root"), past]);
  await setup2.waitForVisualIdle();
  expect(setup2.captureCharFrame()).not.toContain("task_2");
});

it("树线对齐父圆点/括号中心列：├─/└─ 放 main 圆点列、子层 │ 对齐父 ( ) 括号中心", async () => {
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
  const mainLine = lines.find((l) => l.includes("● main")) ?? "";
  const t1 = lines.find((l) => l.includes("( ) task_1")) ?? "";
  const t2 = lines.find((l) => l.includes("(√) task_2")) ?? "";
  const sub = lines.find((l) => l.includes("(√) sub")) ?? "";
  // main 圆点列（● main 的 ●，AgentStrip paddingX=1 后实际列）
  const mainDotCol = mainLine.indexOf("●");
  // 子行连接线 ├─/└─ 放 main 圆点列（main 无括号，层级竖线对齐父圆点）
  expect(t1.indexOf("├")).toBe(mainDotCol);
  expect(t2.indexOf("└")).toBe(mainDotCol);
  // task_1 括号中心列 = ( ) 中间空格列
  const t1Center = t1.indexOf("(") + 1;
  // sub 行：│ 在 main 圆点列（main 还有 task_2 兄弟）、└ 在 task_1 括号中心列
  expect(sub[mainDotCol]).toBe("│");
  expect(sub.indexOf("└")).toBe(t1Center);
});

it("树形深度 2（P4-4）：孙 agent 渲染、树线对齐父括号中心、全程四行", async () => {
  const t = Date.now();
  const setup = await render([
    running("/root"),
    running("/root/task_a"),
    running("/root/task_a/grand"),
    running("/root/task_b"),
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("( ) task_a");
  expect(frame).toContain("( ) grand");
  expect(frame).toContain("( ) task_b");
  // grand 行：│ 对齐 main 圆点列（task_b 是 main 的后续兄弟）、└ 对齐 task_a 括号中心
  const lines = frame.split("\n");
  const mainLine = lines.find((l) => l.includes("● main")) ?? "";
  const taLine = lines.find((l) => l.includes("task_a")) ?? "";
  const grandLine = lines.find((l) => l.includes("grand")) ?? "";
  const mainDotCol = mainLine.indexOf("●");
  expect(grandLine[mainDotCol]).toBe("│");
  expect(grandLine.indexOf("└")).toBe(taLine.indexOf("(") + 1);
});

it("嵌套派生同名末段带父名前缀区分（/root/a/sub 与 /root/b/sub）", async () => {
  const setup = await render([
    running("/root"),
    running("/root/a"),
    running("/root/b"),
    running("/root/a/sub"),
    running("/root/b/sub"),
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("( ) a/sub");
  expect(frame).toContain("( ) b/sub");
});

it("不同父下无同名冲突时仍显示纯末段", async () => {
  const setup = await render([running("/root"), running("/root/alpha"), running("/root/beta")]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("( ) alpha");
  expect(frame).toContain("( ) beta");
});
