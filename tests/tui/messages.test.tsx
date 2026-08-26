/**
 * 层 1：消息流渲染——用户/助手/思考折叠/工具卡/子agent/错误/流式 各块的字符帧断言。
 */
import { testRender } from "@opentui/solid";
import { it, expect } from "vitest";
import { Messages } from "../../src/tui/view/Messages.js";
import type { BlockView, Streaming } from "../../src/tui/state.js";

const app = (blocks: BlockView[], streaming?: Streaming) =>
  testRender(() => <Messages blocks={blocks} modelLabel="test-model" streaming={streaming} />, {
    width: 60,
    height: 16,
  });

it("用户消息带头部与文本", async () => {
  const setup = await app([
    { kind: "message", id: "u1", role: "user", text: "重构 partition 逻辑", time: "14:00:01", thinkingCollapsed: true },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("你");
  expect(frame).toContain("重构 partition 逻辑");
});

it("助手消息带思考折叠（收起显示「思考」）", async () => {
  const setup = await app([
    {
      kind: "message",
      id: "a1",
      role: "assistant",
      text: "先看现状实现",
      thinking: "这一步要核对现有分区逻辑…",
      thinkingCollapsed: true,
      time: "14:00:02",
    },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("先看现状实现");
  expect(frame).toContain("思考（▸");
});

it("工具卡按状态显示图标与名称", async () => {
  const ok = await app([
    { kind: "tool", index: 0, turn: 0, name: "read", args: '{"path":"a.ts"}', status: "success", collapsedArgs: true, collapsedOutput: false, output: "export function a() {}" },
  ]);
  await ok.waitForVisualIdle();
  const frame = ok.captureCharFrame();
  expect(frame).toContain("✓");
  expect(frame).toContain("read");
  // 卡片 rounded 框线（视觉分隔体系：边框内标题）
  expect(frame).toContain("╭");

  const fail = await app([
    { kind: "tool", index: 0, turn: 0, name: "grep", args: "{}", status: "failure", error: "Invalid pattern", collapsedArgs: true, collapsedOutput: false },
  ]);
  await fail.waitForVisualIdle();
  expect(fail.captureCharFrame()).toContain("✕");
  expect(fail.captureCharFrame()).toContain("Invalid pattern");
});

it("子 agent 活动行带路径与状态；结论默认折叠、点击展开", async () => {
  const calls: number[] = [];
  const setup = await testRender(
    () => (
      <Messages
        blocks={[{ kind: "agent", event: "completed", path: "/root/task_1", conclusion: "已合并分区逻辑", collapsed: true }]}
        modelLabel="m"
        onFoldAt={(i) => calls.push(i)}
      />
    ),
    { width: 60, height: 16 },
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("子 agent [/root/task_1]");
  expect(frame).toContain("点击展开");
  expect(frame).not.toContain("已合并分区逻辑"); // 折叠时结论不展示
  // 点子 agent 行 → fold-at(0)（结论可折叠，与工具卡同交互；第一块上方 marginTop 空行，头部在 y=1）
  await setup.mockMouse.click(30, 1);
  await setup.waitForVisualIdle();
  expect(calls).toEqual([0]);
});

it("子 agent 结论展开后显示结论与合并（默认折叠，点击展开）", async () => {
  const setup = await app([
    { kind: "agent", event: "completed", path: "/root/task_1", conclusion: "已合并分区逻辑", mergeResult: "2 处改动", collapsed: false },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("子 agent [/root/task_1]");
  expect(frame).toContain("结论：已合并分区逻辑");
  expect(frame).toContain("合并：2 处改动");
});

it("流式尾显示思考与增量文本", async () => {
  const setup = await app([], { text: "正在处理…", thinking: "展开中", isError: false });
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("正在处理");
  expect(frame).toContain("思考（展开中…）");
});

it("错误块标红警示", async () => {
  const setup = await app([
    { kind: "message", id: "e1", role: "assistant", text: "模型响应超时", isError: true, thinkingCollapsed: true },
  ]);
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("模型响应超时");
  expect(setup.captureCharFrame()).toContain("⚠");
});

it("每块首行圆点标记 + 内容缩进到第 3 列（后续行只空不标）", async () => {
  const setup = await app([
    { kind: "message", id: "u1", role: "user", text: "第一行\n第二行也缩进", time: "14:00:01", thinkingCollapsed: true },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // 首行标记：● 后内容（点列 = 前面 ●，内容从第 3 列起）
  expect(frame).toContain("●");
  // 多行文本后续行也缩进（在 ● 所在行之后能找到「  第二行也缩进」—— 缩进到第 3 列）
  expect(frame).toMatch(/\n\s{3,}第二行也缩进/);
});

it("点工具卡非头部位置（标题行/输出区）触发折叠——折叠命中扩到整卡", async () => {
  const calls: number[] = [];
  const setup = await testRender(
    () => (
      <Messages
        blocks={[
          {
            kind: "tool",
            index: 0,
            turn: 0,
            name: "read",
            args: '{"path":"a.ts"}',
            status: "success",
            collapsedArgs: true,
            collapsedOutput: false,
            output: "export function a() {}",
          },
        ]}
        modelLabel="test-model"
        onFoldAt={(i) => calls.push(i)}
      />
    ),
    { width: 60, height: 16 },
  );
  await setup.waitForVisualIdle();
  // 卡片布局：y1=标题边框行、y2=参数行（旧折叠头）、y3=输出区。点 y1/y3 这些旧代码无折叠命中区的位置，
  // 应命中整卡 onMouseUp → fold-at(0)（底边框行 opentui 不派发鼠标事件，不作为命中区断言）
  await setup.mockMouse.click(30, 1);
  await setup.waitForVisualIdle();
  expect(calls).toEqual([0]);
  await setup.mockMouse.click(30, 3);
  await setup.waitForVisualIdle();
  expect(calls).toEqual([0, 0]);
});

it("拖选文本/右键抬起不触发折叠——仅左键同点按下抬起命中", async () => {
  const calls: number[] = [];
  const setup = await testRender(
    () => (
      <Messages
        blocks={[
          {
            kind: "tool",
            index: 0,
            turn: 0,
            name: "read",
            args: '{"path":"a.ts"}',
            status: "success",
            collapsedArgs: true,
            collapsedOutput: true,
          },
        ]}
        modelLabel="test-model"
        onFoldAt={(i) => calls.push(i)}
      />
    ),
    { width: 60, height: 16 },
  );
  await setup.waitForVisualIdle();
  // 从参数文本自身拖到另一列释放（拖选）：按下抬起不同点，不折叠
  await setup.mockMouse.drag(20, 2, 40, 2);
  await setup.waitForVisualIdle();
  expect(calls).toEqual([]);
  // 右键点击卡片（button=2）：不折叠
  await setup.mockMouse.click(30, 2, 2);
  await setup.waitForVisualIdle();
  expect(calls).toEqual([]);
  // 左键同点点击卡片（正常点击）：折叠
  await setup.mockMouse.click(30, 2);
  await setup.waitForVisualIdle();
  expect(calls).toEqual([0]);
});

it("点思考展开内容中部收起——折叠命中扩到整个思考块", async () => {
  const calls: number[] = [];
  const setup = await testRender(
    () => (
      <Messages
        blocks={[
          {
            kind: "message",
            id: "a1",
            role: "assistant",
            text: "先看现状实现",
            thinking: "这一步要核对现有分区逻辑……",
            thinkingCollapsed: false,
            time: "14:00:02",
          },
        ]}
        modelLabel="test-model"
        onFoldAt={(i) => calls.push(i)}
      />
    ),
    { width: 60, height: 16 },
  );
  await setup.waitForVisualIdle();
  // 思考在前布局：y0=消息头、y1=▼ 思考 折叠头、y2=思考内容（非头部行）、y3=结论文本。
  // 点思考展开内容（y2）也应触发 fold-at(0)
  await setup.mockMouse.click(30, 2);
  await setup.waitForVisualIdle();
  expect(calls).toEqual([0]);
});

/** 逐行扫描首列 ● 的 fg 颜色（hex），按出现顺序返回（fg.buffer 运行时为 RGBA 字节，类型标 Uint16Array 陈旧，按 ArrayLike 读） */
function dotColors(frame: { lines: Array<{ spans: Array<{ text: string; fg?: unknown }> }> }): string[] {
  const colors: string[] = [];
  for (const line of frame.lines) {
    for (const span of line.spans) {
      if (span.text === "●") {
        const buf = (span.fg as { buffer?: ArrayLike<number> } | undefined)?.buffer;
        if (!buf) continue;
        colors.push(`#${[0, 1, 2].map((i) => (buf[i] ?? 0).toString(16).padStart(2, "0")).join("")}`);
      }
    }
  }
  return colors;
}

/** 取首个文本等于 text 的 span 的 fg 颜色（hex）；无匹配或无颜色返回 undefined */
function textFg(frame: { lines: Array<{ spans: Array<{ text: string; fg?: unknown }> }> }, text: string): string | undefined {
  for (const line of frame.lines) {
    for (const span of line.spans) {
      if (span.text === text) {
        const buf = (span.fg as { buffer?: ArrayLike<number> } | undefined)?.buffer;
        if (!buf) return undefined;
        return `#${[0, 1, 2].map((i) => (buf[i] ?? 0).toString(16).padStart(2, "0")).join("")}`;
      }
    }
  }
  return undefined;
}

it("圆点配色：你=紫、模型=蓝、工具/思考=灰、通知=橙", async () => {
  const setup = await testRender(
    () => (
      <Messages
        blocks={[
          { kind: "message", id: "u1", role: "user", text: "hi", thinkingCollapsed: true },
          { kind: "message", id: "a1", role: "assistant", text: "hello", thinkingCollapsed: true },
          { kind: "tool", index: 0, turn: 0, name: "read", args: "{}", status: "success", collapsedArgs: true, collapsedOutput: true },
          { kind: "notice", id: "n1", text: "模型切换", time: "12:00:00" },
        ]}
        modelLabel="m"
      />
    ),
    { width: 40, height: 12 },
  );
  await setup.waitForVisualIdle();
  const colors = dotColors(setup.captureSpans());
  expect(colors[0]).toBe("#9d7cd8"); // 你=强调紫
  expect(colors[1]).toBe("#61afef"); // 模型=蓝
  expect(colors[2]).toBe("#8f9096"); // 工具=灰
  expect(colors[3]).toBe("#f0a94a"); // 通知=警示橙（路由切换等提醒保持醒目）
});

it("助手消息头模型名蓝色（与圆点同色 modelColor）；用户侧「你」保持强调紫", async () => {
  const setup = await app([
    { kind: "message", id: "u1", role: "user", text: "hi", thinkingCollapsed: true },
    { kind: "message", id: "a1", role: "assistant", text: "hello", thinkingCollapsed: true },
  ]);
  await setup.waitForVisualIdle();
  const spans = setup.captureSpans();
  expect(textFg(spans, "test-model")).toBe("#61afef"); // 模型名=蓝
  expect(textFg(spans, "你")).toBe("#9d7cd8"); // 你=强调紫
});

it("思考/工具展开后内容保持灰色（与折叠提示同灰调，用户复核反馈）", async () => {
  const setup = await app([
    { kind: "message", id: "a1", role: "assistant", text: "结论", thinking: "这一步要核对分区逻辑…", thinkingCollapsed: false },
    { kind: "tool", index: 0, turn: 0, name: "read", args: "{}", status: "success", collapsedArgs: true, collapsedOutput: false, output: "export function a() {}" },
  ]);
  await setup.waitForVisualIdle();
  const spans = setup.captureSpans();
  expect(textFg(spans, "这一步要核对分区逻辑…")).toBe("#8f9096"); // 思考展开内容=灰
  expect(textFg(spans, "export function a() {}")).toBe("#8f9096"); // 工具输出展开=灰
});

it("思考块渲染在消息文本之前（思考在前、结论在后，用户复核反馈）", async () => {
  const setup = await app([
    { kind: "message", id: "a1", role: "assistant", text: "先看结论", thinking: "思考步骤…", thinkingCollapsed: false },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  const lines = frame.split("\n");
  const thinkingIdx = lines.findIndex((l) => l.includes("▼ 思考"));
  const textIdx = lines.findIndex((l) => l.includes("先看结论"));
  expect(thinkingIdx).toBeGreaterThanOrEqual(0); // 思考块存在
  expect(textIdx).toBeGreaterThan(thinkingIdx); // 思考行在消息文本之前
});