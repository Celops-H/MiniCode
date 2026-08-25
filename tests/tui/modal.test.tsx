/**
 * 层 1：嵌入弹块——权限确认 / 会话切换面板渲染断言。
 */
import { testRender } from "@opentui/solid";
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
  expect(frame).toContain("[a] 允许会话全部");
  expect(frame).toContain("[d] 拒绝");
  // selected=1 即「允许会话全部」高亮（带 ◀ 标记）
  expect(frame).toContain("◀");
  // 框线（视觉分隔体系：权限弹窗 rounded 边框 + 边框内标题）
  expect(frame).toContain("╭");
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