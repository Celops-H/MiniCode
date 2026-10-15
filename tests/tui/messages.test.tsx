/**
 * 层 1：消息流渲染——用户/助手/思考折叠/工具卡/子agent/错误/流式 各块的字符帧断言。
 */
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { it, expect } from "vitest";
import { Messages, StreamingView } from "../../src/tui/view/Messages.js";
import type { BlockView, Streaming } from "../../src/tui/state.js";

const app = (blocks: BlockView[], streaming?: Streaming) =>
  testRender(() => <Messages blocks={blocks} modelLabel="test-model" streaming={streaming} />, {
    width: 60,
    height: 16,
  });

/** 取首个含 text 的 span 的 fg（hex）；无匹配/无颜色返回 undefined */
function spanFgOf(spans: { lines: Array<{ spans: Array<{ text: string; fg?: unknown }> }> }, text: string): string | undefined {
  for (const line of spans.lines) {
    for (const span of line.spans) {
      if (span.text.includes(text)) {
        const buf = (span.fg as { buffer?: ArrayLike<number> } | undefined)?.buffer;
        if (!buf) return undefined;
        return `#${[0, 1, 2].map((i) => (buf[i] ?? 0).toString(16).padStart(2, "0")).join("")}`;
      }
    }
  }
  return undefined;
}

it("用户消息带头部与文本；「你」标签与圆点为绿、模型标签为浅蓝", async () => {
  const setup = await app([
    { kind: "message", id: "u1", role: "user", text: "重构 partition 逻辑", time: "14:00:01", thinkingCollapsed: true },
    { kind: "message", id: "a1", role: "assistant", text: "好的", thinkingCollapsed: true },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("你");
  expect(frame).toContain("重构 partition 逻辑");
  // 「你」标签绿（success #7fd88f）、模型标签浅蓝（modelColor #61afef），与主题色板一致
  expect(spanFgOf(setup.captureSpans(), "你")).toBe("#7fd88f");
  expect(spanFgOf(setup.captureSpans(), "test-model")).toBe("#61afef");
});

it("空模型（连接引导态）助手署名回落「未连接」占位，不留空白署名", async () => {
  // 引导态发消息落出的错误块：产出模型与会话模型都是空串快照
  const setup = await testRender(
    () => (
      <Messages
        blocks={[
          { kind: "message", id: "e1", role: "assistant", model: "", text: "未知模型", isError: true, thinkingCollapsed: true, time: "14:00:03" },
        ]}
        modelLabel=""
      />
    ),
    { width: 60, height: 16 },
  );
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("未连接");
  // 正常署名不受影响：消息带产出模型时仍按产出模型显示
  const named = await app([
    { kind: "message", id: "a2", role: "assistant", model: "glm-4.5", text: "好的", thinkingCollapsed: true },
  ]);
  await named.waitForVisualIdle();
  expect(named.captureCharFrame()).toContain("glm-4.5");
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

it("工具卡按状态显示图标与名称（compact 浓缩：只读快工具去框线）", async () => {
  const ok = await app([
    { kind: "tool", index: 0, turn: 0, name: "read", args: '{"path":"a.ts"}', status: "success", collapsedArgs: true, collapsedOutput: false, output: "export function a() {}" },
  ]);
  await ok.waitForVisualIdle();
  const frame = ok.captureCharFrame();
  expect(frame).toContain("✓");
  expect(frame).toContain("read");
  // compact 浓缩后无框线（③工具浓缩：glob/read/grep 单行摘要风格）
  expect(frame).toContain("a.ts");
  expect(frame).not.toContain("╭");

  const fail = await app([
    { kind: "tool", index: 0, turn: 0, name: "grep", args: "{}", status: "failure", error: "Invalid pattern", collapsedArgs: true, collapsedOutput: false },
  ]);
  await fail.waitForVisualIdle();
  expect(fail.captureCharFrame()).toContain("✕");
  expect(fail.captureCharFrame()).toContain("Invalid pattern");
});

it("compact 工具完成收敛单行摘要（点击展开全文）", async () => {
  const setup = await app([
    { kind: "tool", index: 0, turn: 0, name: "read", args: '{"path":"src/a.ts"}', status: "success", collapsedArgs: true, collapsedOutput: true, output: "line1\nline2\nline3" },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // 折叠态单行：图标+名+参数摘要+输出行数提示
  expect(frame).toContain("✓ read src/a.ts");
  expect(frame).toContain("输出 3 行 · 点击展开");
  expect(frame).not.toContain("line1"); // 输出隐藏
});

it("compact 失败卡（只有错误无输出）折叠摘要显示「错误详情」，与 bash/generic 同口径", async () => {
  const setup = await app([
    { kind: "tool", index: 0, turn: 0, name: "read", args: '{"path":"a.ts"}', status: "failure", error: "文件不存在", collapsedArgs: true, collapsedOutput: true },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("错误详情 · 点击展开");
  expect(frame).not.toContain("输出 0 行"); // 无输出时不报「输出 0 行」
  expect(frame).not.toContain("文件不存在"); // 折叠时错误全文不展示
  // 有输出时仍按「输出 N 行」显示（与 generic 同优先级：输出在前、错误详情兜底）
  const both = await app([
    { kind: "tool", index: 0, turn: 0, name: "read", args: '{"path":"a.ts"}', status: "failure", error: "末尾告警", output: "line1\nline2", collapsedArgs: true, collapsedOutput: true },
  ]);
  await both.waitForVisualIdle();
  expect(both.captureCharFrame()).toContain("输出 2 行 · 点击展开");
});

it("bash 紧凑块：命令首行 + 折叠输出行数提示，无边框", async () => {
  const setup = await app([
    { kind: "tool", index: 0, turn: 0, name: "bash", args: '{"command":"pnpm test"}', status: "success", collapsedArgs: true, collapsedOutput: true, output: "ok\npass" },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Bash pnpm test");
  expect(frame).toContain("输出 2 行 · 点击展开");
  expect(frame).not.toContain("╭"); // 无框线
});

it("generic 未特判工具默认单行：参数摘要展示、输出隐藏可展开", async () => {
  const setup = await app([
    { kind: "tool", index: 0, turn: 0, name: "write", args: '{"path":"x.ts"}', status: "success", collapsedArgs: true, collapsedOutput: true, output: "written" },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("write x.ts");
  expect(frame).toContain("· 点击展开");
  expect(frame).not.toContain("written"); // 输出隐藏
});

it("子 agent 活动行带路径与状态；结论默认折叠、点击展开", async () => {
  const calls: number[] = [];
  const setup = await testRender(
    () => (
      <Messages
        blocks={[{ kind: "agent", event: "completed", path: "/root/task_1", tools: [], conclusion: "已合并分区逻辑", collapsed: true }]}
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
    { kind: "agent", event: "completed", path: "/root/task_1", tools: [], conclusion: "已合并分区逻辑", mergeResult: "2 处改动", collapsed: false },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("子 agent [/root/task_1]");
  expect(frame).toContain("结论：已合并分区逻辑");
  expect(frame).toContain("合并：2 处改动");
});

it("子 agent 失败活动行：红字「失败」与完成区分，失败文本可展开", async () => {
  const collapsed = await app([
    { kind: "agent", event: "failed", path: "/root/task_1", tools: [], conclusion: "子代理 task_1 失败：连接超时", collapsed: true },
  ]);
  await collapsed.waitForVisualIdle();
  const frame = collapsed.captureCharFrame();
  expect(frame).toContain("子 agent [/root/task_1]");
  expect(frame).toContain("失败");
  expect(frame).not.toContain("完成");
  expect(frame).toContain("点击展开");
  expect(frame).not.toContain("连接超时"); // 折叠时失败文本不展示
  // 失败行红字（error #e06c75），与工具失败的红色语义一致
  expect(spanFgOf(collapsed.captureSpans(), "失败")).toBe("#e06c75");
  // 首行圆点同步转红（失败块整块按错误语义显示，不只状态词）
  expect(spanFgOf(collapsed.captureSpans(), "●")).toBe("#e06c75");
  // 展开显示失败文本（结论）
  const expanded = await app([
    { kind: "agent", event: "failed", path: "/root/task_1", tools: [], conclusion: "子代理 task_1 失败：连接超时", collapsed: false },
  ]);
  await expanded.waitForVisualIdle();
  expect(expanded.captureCharFrame()).toContain("结论：子代理 task_1 失败：连接超时");
});

it("子 agent 空结论活动行：警示措辞「未产出结论」，不与真完成同形", async () => {
  // 模型未产出正文（conclusion 为空串）：旧行为显示「完成 · 输出 1 行」（占位文案计一行）
  const setup = await app([
    { kind: "agent", event: "completed", path: "/root/task_1", tools: [], conclusion: "", collapsed: true },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("子 agent [/root/task_1]");
  expect(frame).toContain("未产出结论");
  expect(frame).not.toContain("输出 1 行");
  // 警示色（warning），与正常完成的灰字区分
  expect(spanFgOf(setup.captureSpans(), "未产出结论")).toBe("#e06c75");
});

it("子 agent 活动块折叠态：标题带工具调用次数，段内工具与结论都不铺屏", async () => {
  // 段头一行要容纳「完成 · 工具调用 3 次 · 输出 1 行（▸ 点击展开）」：80 列防折行干扰断言
  const setup = await testRender(
    () => (
      <Messages
        blocks={[
          {
            kind: "agent",
            event: "completed",
            path: "/root/task_1",
            tools: [
              { id: "c1", name: "bash", args: '{"command":"pnpm test"}', status: "success", durationMs: 3200 },
              { id: "c2", name: "read", args: '{"path":"src/a.ts"}', status: "failure", error: "路径不存在" },
              { id: "c3", name: "grep", args: '{"pattern":"foo"}', status: "running" },
            ],
            conclusion: "冒烟通过",
            collapsed: true,
          },
        ]}
        modelLabel="test-model"
      />
    ),
    { width: 80, height: 16 },
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("子 agent [/root/task_1]");
  expect(frame).toContain("工具调用 3 次");
  expect(frame).toContain("输出 1 行");
  expect(frame).toContain("点击展开");
  // 折叠态：工具行与结论都不展示（主消息区只有一行段头）
  expect(frame).not.toContain("pnpm test");
  expect(frame).not.toContain("冒烟通过");
});

it("子 agent 活动块展开：结论在前、工具行在后，失败原因只取首行", async () => {
  const setup = await app([
    {
      kind: "agent",
      event: "failed",
      path: "/root/task_1",
      tools: [
        { id: "c1", name: "bash", args: '{"command":"pnpm build"}', status: "failure", error: "命令失败：退出码 1\n细节行", durationMs: 500 },
      ],
      conclusion: "子代理 task_1 失败：连接超时",
      collapsed: false,
    },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("结论：子代理 task_1 失败：连接超时");
  expect(frame).toContain("bash pnpm build");
  expect(frame).toContain("命令失败：退出码 1");
  expect(frame).toContain("耗时 500ms");
  expect(frame).not.toContain("细节行"); // 失败原因单行收敛（首行截断，多行明细不进块）
  // 结论行在工具行之前（点开先读结论，过程梗概在后）
  const lines = frame.split("\n");
  expect(lines.findIndex((l) => l.includes("结论："))).toBeLessThan(lines.findIndex((l) => l.includes("bash pnpm build")));
});

it("子 agent 段内工具行：失败原因超 60 字截断加省略号", async () => {
  const error = "e".repeat(80);
  const setup = await testRender(
    () => (
      <Messages
        blocks={[
          {
            kind: "agent",
            event: "failed",
            path: "/root/t",
            tools: [{ id: "c1", name: "bash", args: "{}", status: "failure", error }],
            conclusion: "失败",
            collapsed: false,
          },
        ]}
        modelLabel="m"
      />
    ),
    { width: 100, height: 12 },
  );
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain(`${"e".repeat(60)}…`);
  expect(frame).not.toContain("e".repeat(61));
});

it("同屏失败与完成块各按自身状态着色（不互相串色）", async () => {
  const setup = await app([
    { kind: "agent", event: "failed", path: "/root/task_1", tools: [], conclusion: "子代理 task_1 失败：连接超时", collapsed: true },
    { kind: "agent", event: "completed", path: "/root/task_2", tools: [], conclusion: "已合并分区逻辑", collapsed: true },
  ]);
  await setup.waitForVisualIdle();
  const spans = setup.captureSpans();
  expect(spanFgOf(spans, "失败")).toBe("#e06c75"); // 失败块红
  expect(spanFgOf(spans, "完成")).toBe("#8f9096"); // 完成块保持灰
});

it("流式尾显示思考与增量文本", async () => {
  const setup = await app([], { text: "正在处理…", thinking: "展开中" });
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("正在处理");
  expect(frame).toContain("思考（展开中…）");
});

it("流式尾：收尾当帧 streaming 已置空时不抛异常（done 清空 store 节点的防御）", async () => {
  // 收尾把 state.streaming 清为 undefined 的那一帧里，流式尾组件的条件求值可能先于
  // 外层「有流式才渲染」的移除完成——s 拿到 undefined。旧实现在这里抛 TypeError，
  // 异常沿宿主渲染回调上抛会中断本轮收尾（回复不落盘、界面卡「运行中」）
  const [streaming, setStreaming] = createSignal<Streaming | undefined>({ text: "半截回复", thinking: "想" });
  const setup = await testRender(() => <StreamingView s={streaming()} />, { width: 40, height: 6 });
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("半截回复");
  setStreaming(undefined);
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).not.toContain("半截回复");
});

it("错误块标红警示", async () => {
  const setup = await app([
    { kind: "message", id: "e1", role: "assistant", text: "模型响应超时", isError: true, thinkingCollapsed: true },
  ]);
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("模型响应超时");
  expect(setup.captureCharFrame()).toContain("⚠");
});

it("错误块署名取块自带模型：与会话当前模型不同时显示块模型（切模型后旧错误行不翻转）", async () => {
  const setup = await app([
    { kind: "message", id: "e1", role: "assistant", model: "model-a", text: "模型响应超时", isError: true, thinkingCollapsed: true },
  ]);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("model-a");
  expect(frame).not.toContain("test-model");
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
  // 从参数文本自身拖到另一列释放（拖选）：按下抬起不同点，不折叠（compact 单行摘要 y=1）
  await setup.mockMouse.drag(20, 1, 40, 1);
  await setup.waitForVisualIdle();
  expect(calls).toEqual([]);
  // 右键点击卡片（button=2）：不折叠
  await setup.mockMouse.click(30, 1, 2);
  await setup.waitForVisualIdle();
  expect(calls).toEqual([]);
  // 左键同点点击卡片（正常点击）：折叠
  await setup.mockMouse.click(30, 1);
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

it("圆点配色：你=绿、模型=蓝、工具/思考=灰、通知=红（2026-08-28 用户改色）", async () => {
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
  expect(colors[0]).toBe("#7fd88f"); // 你=绿（success，与模型蓝区分）
  expect(colors[1]).toBe("#61afef"); // 模型=蓝
  expect(colors[2]).toBe("#8f9096"); // 工具=灰
  expect(colors[3]).toBe("#e06c75"); // 通知=警示红（红色承担严重/警告语义）
});

it("助手消息头模型名蓝色（与圆点同色 modelColor）；用户侧「你」为绿", async () => {
  const setup = await app([
    { kind: "message", id: "u1", role: "user", text: "hi", thinkingCollapsed: true },
    { kind: "message", id: "a1", role: "assistant", text: "hello", thinkingCollapsed: true },
  ]);
  await setup.waitForVisualIdle();
  const spans = setup.captureSpans();
  expect(textFg(spans, "test-model")).toBe("#61afef"); // 模型名=蓝
  expect(textFg(spans, "你")).toBe("#7fd88f"); // 你=绿（success，与模型蓝区分）
});

it("思考/工具展开后内容保持灰色（与折叠提示同灰调）", async () => {
  const setup = await app([
    { kind: "message", id: "a1", role: "assistant", text: "结论", thinking: "这一步要核对分区逻辑…", thinkingCollapsed: false },
    { kind: "tool", index: 0, turn: 0, name: "read", args: "{}", status: "success", collapsedArgs: true, collapsedOutput: false, output: "export function a() {}" },
  ]);
  await setup.waitForVisualIdle();
  const spans = setup.captureSpans();
  expect(textFg(spans, "这一步要核对分区逻辑…")).toBe("#8f9096"); // 思考展开内容=灰
  expect(textFg(spans, "export function a() {}")).toBe("#8f9096"); // 工具输出展开=灰
});

it("思考块渲染在消息文本之前（思考在前、结论在后）", async () => {
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
it("折叠块悬停：摘要文字变白，移开恢复灰（不再整块背景抬高）", async () => {
  const setup = await app([
    { kind: "tool", index: 0, turn: 0, name: "read", args: '{"path":"a.ts"}', status: "success", collapsedArgs: true, collapsedOutput: true, output: "内容" },
  ]);
  await setup.waitForVisualIdle();
  // 悬停前：摘要文字灰（textMuted）
  expect(spanFgOf(setup.captureSpans(), "read")).toBe("#8f9096");
  // 移入工具卡（第一行）：文字变白（theme.text）
  await setup.mockMouse.moveTo(5, 1);
  await setup.waitForVisualIdle();
  expect(spanFgOf(setup.captureSpans(), "read")).toBe("#ececf0");
  // 移开：恢复灰
  await setup.mockMouse.moveTo(5, 10);
  await setup.waitForVisualIdle();
  expect(spanFgOf(setup.captureSpans(), "read")).toBe("#8f9096");
});

it("compact 工具点击展开：点卡后输出全文可见（真实 click 断言）", async () => {
  const [blocks, setBlocks] = createSignal<BlockView[]>([
    { kind: "tool", index: 0, turn: 0, name: "read", args: '{"path":"a.ts"}', status: "success", collapsedArgs: true, collapsedOutput: true, output: "line1\nline2" },
  ]);
  const setup = await testRender(
    () => (
      <Messages
        blocks={blocks()}
        modelLabel="m"
        onFoldAt={() =>
          setBlocks(blocks().map((b) => (b.kind === "tool" ? { ...b, collapsedOutput: false } : b)))
        }
      />
    ),
    { width: 60, height: 16 },
  );
  await setup.waitForVisualIdle();
  // 折叠态：输出隐藏
  expect(setup.captureCharFrame()).not.toContain("line1");
  // 点卡 → 展开：输出全文可见
  await setup.mockMouse.click(30, 1);
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("line1");
  expect(frame).toContain("line2");
});

it("滚轮滚动消息区：滚轮后内容滚动（滚轮加速接线）", async () => {
  const blocks: BlockView[] = Array.from({ length: 15 }, (_, i) => ({
    kind: "message", id: `m${i}`, role: "user", text: `消息 ${i}`, thinkingCollapsed: true,
  }));
  const setup = await testRender(
    () => <Messages blocks={blocks} modelLabel="m" />,
    { width: 60, height: 10 },
  );
  await setup.waitForVisualIdle();
  const before = setup.captureCharFrame();
  // stickyScroll 贴底：首屏显示底部消息，顶部「消息 0」不在视野
  expect(before).not.toContain("消息 0");
  // 向上滚 3 次（每次 ×3 行）：离开底部、内容滚动（接线生效，帧必须变化）
  for (let i = 0; i < 3; i++) {
    await setup.mockMouse.scroll(30, 5, "up");
    await setup.waitForVisualIdle();
  }
  const after = setup.captureCharFrame();
  // 帧必须变化 = 滚动接线生效（具体滚动量取决于块高，不作精确断言）
  expect(after, `SCROLL-AFTER=${JSON.stringify(after)}`).not.toEqual(before);
});
