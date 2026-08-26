/**
 * 层 1：嵌入弹块——权限确认 / 会话切换面板渲染断言。
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

it("会话面板：列表/新建入口/键位提示", async () => {
  const modal: ModalState = {
    kind: "session",
    sessions: [{ id: "ab3f90", model: "deepseek-v4-flash", updatedAt: "now" }],
    selected: 0,
  };
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 60, height: 8 });
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("切换会话");
  expect(frame).toContain("ab3f90");
  expect(frame).toContain("deepseek-v4-flash");
  expect(frame).toContain("新建会话");
});

it("会话面板超页：窗口渲染且选中项随导航滚动入视野，不溢出", async () => {
  const sessions = Array.from({ length: 12 }, (_, i) => ({
    id: `sxx-${String(i).padStart(2, "0")}`,
    model: "m",
    updatedAt: "now",
  }));
  const [modal, setModal] = createStore<ModalState>({ kind: "session", sessions, selected: 0 });
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 50, height: 12 });
  await setup.waitForVisualIdle();
  let frame = setup.captureCharFrame();
  // 选中第 0 项在视野，最末会话不显示（窗口渲染）
  expect(frame).toContain("sxx-00");
  expect(frame).not.toContain("sxx-11");
  setModal({ kind: "session", sessions, selected: 8 });
  await setup.waitForVisualIdle();
  frame = setup.captureCharFrame();
  // 导航到第 8 项后窗口滚动：8 号入视野、0 号脱离
  expect(frame).toContain("sxx-08");
  expect(frame).not.toContain("sxx-00");
});

it("/connect 供应商选择：列出厂商与键位提示，选中高亮", async () => {
  const modal: ModalState = {
    kind: "connect",
    providers: [
      { id: "deepseek", name: "DeepSeek", defaultModel: "deepseek-chat" },
      { id: "openai", name: "OpenAI", defaultModel: "gpt-4o" },
    ],
    selected: 0,
  };
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 60, height: 8 });
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("连接供应商");
  expect(frame).toContain("DeepSeek");
  expect(frame).toContain("OpenAI");
  expect(frame).toContain("▸");
  expect(frame).toContain("输入 API Key");
});

it("/model 弹窗：模型列表 + 思考等级行 + 键位提示", async () => {
  const modal: ModalState = { kind: "model", models: [{ id: "deepseek-chat" }, { id: "gpt-4o" }], selected: 0, thinkingLevel: "medium" };
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 60, height: 10 });
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("选择模型");
  expect(frame).toContain("deepseek-chat");
  expect(frame).toContain("gpt-4o");
  expect(frame).toContain("思考等级");
  expect(frame).toContain("medium");
  expect(frame).toContain("←→");
});

it("/connect key 输入弹窗：供应商/环境变量/键位提示；key 输入进度随弹窗内 state 变更重渲", async () => {
  const [modal, setModal] = createStore<ModalState>({
    kind: "connect-key",
    providerId: "deepseek",
    providerName: "DeepSeek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
    key: "",
  });
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 60, height: 8 });
  await setup.waitForVisualIdle();
  let frame = setup.captureCharFrame();
  expect(frame).toContain("输入 API Key");
  expect(frame).toContain("DeepSeek");
  expect(frame).toContain("DEEPSEEK_API_KEY");
  expect(frame).toContain("未输入");
  // 弹窗内嵌状态变更（key 追加）能重渲——同类「For+标量不刷新」风险位（本组件读 b.key 文本）
  setModal({
    kind: "connect-key",
    providerId: "deepseek",
    providerName: "DeepSeek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
    key: "sk-123456",
  });
  await setup.waitForVisualIdle();
  frame = setup.captureCharFrame();
  expect(frame).toContain("sk-123456");
  expect(frame).not.toContain("未输入");
});