/**
 * 层 1：嵌入弹块——权限确认 / 会话面板（P4-3 完全全屏页）渲染断言。
 */
import { testRender } from "@opentui/solid";
import { createStore } from "solid-js/store";
import { it, expect } from "vitest";
import { ModalView } from "../../src/tui/view/Modal.js";
import type { ModalState } from "../../src/tui/state.js";

it("权限弹块：工具名/参数/三决策与选中高亮", async () => {
  const modal: ModalState = {
    kind: "permission",
    toolName: "bash",
    content: "pnpm test",
    argsText: '{"command":"pnpm test"}',
    selected: 1,
  };
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 60, height: 8 });
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("权限确认");
  expect(frame).toContain("bash");
  expect(frame).toContain("pnpm test");
  expect(frame).toContain("[1] 允许本次");
  expect(frame).toContain("[2] 允许会话全部");
  expect(frame).toContain("[3] 拒绝");
  // selected=1 即「允许会话全部」高亮（带 ◀ 标记）
  expect(frame).toContain("◀");
  // 框线（视觉分隔体系：权限弹窗 rounded 边框 + 边框内标题）
  expect(frame).toContain("╭");
  // C-1=50 黑白化：标题去 ⚠ 符号（红色警示符不再用于弹窗美化）
  expect(frame).not.toContain("⚠");
});

it("connect 供应商列表：只显供应商名、不附默认模型（C-7=62）", async () => {
  const modal: ModalState = {
    kind: "connect",
    providers: [
      { id: "deepseek", name: "DeepSeek", defaultModel: "deepseek-chat" },
      { id: "openai", name: "OpenAI", defaultModel: "gpt-4o" },
    ],
    selected: 0,
  };
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 60, height: 10 });
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("连接供应商");
  expect(frame).toContain("DeepSeek");
  expect(frame).toContain("OpenAI");
  // 不附默认模型名（用户定论：供应商列表只需名称）
  expect(frame).not.toContain("deepseek-chat");
  expect(frame).not.toContain("gpt-4o");
});

it("高亮随 selected 挪动（◀ 跟着选中项走）——For+条件曾在此渲染器下不刷新标量的回归", async () => {
  const [modal, setModal] = createStore<ModalState>({
    kind: "permission",
    toolName: "bash",
    content: "pnpm test",
    argsText: "{}",
    selected: 0,
  });
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 60, height: 8 });
  await setup.waitForVisualIdle();
  const pos0 = setup.captureCharFrame().indexOf("◀");
  setModal({ kind: "permission", toolName: "bash", content: "pnpm test", argsText: "{}", selected: 2 });
  await setup.waitForVisualIdle();
  const pos2 = setup.captureCharFrame().indexOf("◀");
  // 从第 1 项挪到第 3 项：◀ 位置右移（3 项间距明显）
  expect(pos2).toBeGreaterThan(pos0);
});

it("会话面板（P4-3 全屏页）：左对齐列表、每条两行主信息+副行、新建入口、Esc 返回提示", async () => {
  const modal: ModalState = {
    kind: "session",
    sessions: [{ id: "ab3f90d1e2", title: "重构 partition", model: "deepseek-v4-flash", updatedAt: new Date(Date.now() - 180_000).toISOString(), sizeBytes: 4096 }],
    selected: 0,
  };
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 60, height: 14 });
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("会话列表");
  expect(frame).toContain("90d1e2"); // 哈希后 6 位
  expect(frame).toContain("重构 partition");
  expect(frame).toContain("deepseek-v4-flash");
  // 副行：相对时间 + 消息文件大小
  expect(frame).toContain("3min ago");
  expect(frame).toContain("4.0 KB");
  expect(frame).toContain("新建会话");
  expect(frame).toContain("Esc 返回");
  // 全屏页无卡片框线（不再是居中定宽卡）
  expect(frame).not.toContain("╭");
});

it("会话面板三列各自对齐：长短标题下模型起始列一致", async () => {
  const modal: ModalState = {
    kind: "session",
    sessions: [
      { id: "aaaa1111", title: "短", model: "model-alpha", updatedAt: "2026-08-27T00:00:00.000Z", sizeBytes: 1024 },
      { id: "bbbb2222", title: "这是一个相当长的会话标题会占很多列宽", model: "model-beta-9", updatedAt: "2026-08-27T00:00:00.000Z", sizeBytes: 1024 },
    ],
    selected: 0,
  };
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 70, height: 16 });
  await setup.waitForVisualIdle();
  const lines = setup.captureCharFrame().split("\n");
  const rowA = lines.find((l) => l.includes("aaaa")) ?? "";
  const rowB = lines.find((l) => l.includes("bbbb")) ?? "";
  // 两行模型名列起点相同（padCols 补齐定宽标题列，长内容截断不顶开模型列）
  expect(rowA.indexOf("model-alpha")).toBe(rowB.indexOf("model-beta-9"));
});

it("会话面板删除态：选中行显示操作态（进入/删除，←→ 切换 P4-2）", async () => {
  const sessions = [{ id: "ab3f90", title: "重构 partition", model: "deepseek-v4-flash", updatedAt: "now", sizeBytes: 2048 }];
  const [modal, setModal] = createStore<ModalState>({ kind: "session", sessions, selected: 0, action: "enter" });
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 60, height: 12 });
  await setup.waitForVisualIdle();
  // 进入态：选中行尾显示 ◀ 进入
  expect(setup.captureCharFrame()).toContain("◀ 进入");
  // ←→ 切删除态：行尾显示 ✕ 删除、键位提示同步
  setModal({ kind: "session", sessions, selected: 0, action: "delete" });
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("✕ 删除");
  expect(frame).toContain("←→ 进入/删除");
});

it("会话面板超页：窗口渲染且选中项随导航滚动入视野", async () => {
  const sessions = Array.from({ length: 12 }, (_, i) => ({
    id: `sxx-${String(i).padStart(2, "0")}`,
    title: `会话 ${i}`,
    model: "m",
    updatedAt: "2026-08-27T00:00:00.000Z",
    sizeBytes: 0,
  }));
  const [modal, setModal] = createStore<ModalState>({ kind: "session", sessions, selected: 0 });
  // 大视口（每条 3 行含空行）：可见 ~6 条，12 条需窗口滚动
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 50, height: 30 });
  await setup.waitForVisualIdle();
  let frame = setup.captureCharFrame();
  expect(frame).toContain("sxx-00");
  expect(frame).not.toContain("sxx-11"); // 窗口外不渲染
  setModal({ kind: "session", sessions, selected: 10 });
  await setup.waitForVisualIdle();
  frame = setup.captureCharFrame();
  // 导航到第 10 条后窗口滚动：10 号入视野、0 号脱离
  expect(frame).toContain("sxx-10");
  expect(frame).not.toContain("sxx-00");
  setModal({ kind: "session", sessions, selected: 11 });
  await setup.waitForVisualIdle();
  frame = setup.captureCharFrame();
  // 底部 clamp：最末条目在视野内
  expect(frame).toContain("sxx-11");
  setModal({ kind: "session", sessions, selected: 12 }); // 新建入口选中
  await setup.waitForVisualIdle();
  frame = setup.captureCharFrame();
  expect(frame).toContain("▸ ── 新建会话 ──");
  expect(frame).toContain("sxx-11");
});
