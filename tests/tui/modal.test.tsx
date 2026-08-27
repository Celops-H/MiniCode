/**
 * 层 1：嵌入弹块——权限确认 / 会话面板（P4-3 完全全屏页）渲染断言。
 */
import { testRender } from "@opentui/solid";
import { createStore } from "solid-js/store";
import { it, expect } from "vitest";
import { ModalView } from "../../src/tui/view/Modal.js";
import { colWidth } from "../../src/tui/view/fit.js";
import type { ModalState } from "../../src/tui/state.js";

/** 判断 CapturedSpan 背景是否为主题浅蓝（foregroundAccent #61afef；RGBA.toInts 为 0-255，.r/.g/.b 是 0-1 归一化） */
function isAccentBg(rgba: { toInts: () => number[] }): boolean {
  const [r, g, b] = rgba.toInts();
  return r === 0x61 && g === 0xaf && b === 0xef;
}

/** 判断 CapturedSpan 前景是否为主题黑底（background #101013） */
function isBlackFg(rgba: { toInts: () => number[] }): boolean {
  const [r, g, b] = rgba.toInts();
  return r === 0x10 && g === 0x10 && b === 0x13;
}

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

it("权限选中项：浅蓝背景块 + 黑字（P6-3 文字保持黑白、选中浅蓝可辨）", async () => {
  const modal: ModalState = {
    kind: "permission",
    toolName: "bash",
    content: "pnpm test",
    argsText: "{}",
    selected: 0,
  };
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 60, height: 8 });
  await setup.waitForVisualIdle();
  const spans = setup.captureSpans().lines.flatMap((l) => l.spans);
  // 选中项 = 浅蓝底（foregroundAccent #61afef）+ 黑字（background #101013）
  const sel = spans.find((s) => isAccentBg(s.bg));
  expect(sel).toBeDefined();
  expect(sel!.text).toContain("允许本次"); // selected=0 即「允许本次」反色
  expect(isBlackFg(sel!.fg)).toBe(true);
  // 未选中项保持灰字（无浅蓝背景）
  const unselected = spans.filter((s) => s.text.includes("允许会话全部"));
  expect(unselected[0] && !isAccentBg(unselected[0].bg)).toBe(true);
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

it("会话面板（P4-3 全屏页）：新建置顶、每条两行主信息+副行、Esc 返回提示", async () => {
  const modal: ModalState = {
    kind: "session",
    sessions: [{ id: "ab3f90d1e2", title: "重构 partition", model: "deepseek-v4-flash", updatedAt: new Date(Date.now() - 180_000).toISOString(), sizeBytes: 4096 }],
    selected: 0,
  };
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 60, height: 14 });
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("会话列表");
  expect(frame).toContain("90d1e2"); // 哈希后 6 位（第三列）
  expect(frame).toContain("重构 partition");
  expect(frame).toContain("deepseek-v4-flash");
  // 副行：相对时间 + 消息文件大小
  expect(frame).toContain("3min ago");
  expect(frame).toContain("4.0 KB");
  // 新建会话置顶默认选中（P6-4）：＋ 图标特殊化，且在会话条目之前
  expect(frame).toContain("＋ 新建会话");
  const lines2 = frame.split("\n");
  const newIdx = lines2.findIndex((l) => l.includes("＋ 新建会话"));
  const sessIdx = lines2.findIndex((l) => l.includes("90d1e2"));
  expect(newIdx).toBeGreaterThanOrEqual(0);
  expect(newIdx).toBeLessThan(sessIdx); // 新建行在会话行之前
  expect(frame).toContain("Esc 返回");
  // 全屏页无卡片框线（不再是居中定宽卡）
  expect(frame).not.toContain("╭");
});

it("会话面板三列各自对齐：长短标题下模型起始列一致（P6-5 列序 标题·模型·哈希）", async () => {
  const modal: ModalState = {
    kind: "session",
    sessions: [
      { id: "aaaa1111", title: "短", model: "model-alpha", updatedAt: "2026-08-27T00:00:00.000Z", sizeBytes: 1024 },
      { id: "bbbb2222", title: "这是一个相当长的会话标题会占很多列宽", model: "model-beta-9", updatedAt: "2026-08-27T00:00:00.000Z", sizeBytes: 1024 },
    ],
    selected: 1,
  };
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 70, height: 16 });
  await setup.waitForVisualIdle();
  const lines = setup.captureCharFrame().split("\n");
  // 用模型列定位行（哈希是 id 后 6 位，如 aaaa1111 → aa1111，不含完整 id）
  const rowA = lines.find((l) => l.includes("model-alpha")) ?? "";
  const rowB = lines.find((l) => l.includes("model-beta-9")) ?? "";
  // 两行模型列（第二列）起始显示列一致：CJK 全角使字符索引 ≠ 列索引，须按 colWidth 折算
  // （padCols 按列宽补空格，长短标题截断后列宽一致）
  const modelColA = colWidth(rowA.slice(0, rowA.indexOf("model-alpha")));
  const modelColB = colWidth(rowB.slice(0, rowB.indexOf("model-beta-9")));
  expect(modelColA).toBe(modelColB);
  // 列序：标题第一列、模型第二列、哈希第三列（模型在标题后、哈希在模型后）
  expect(rowA.indexOf("model-alpha")).toBeGreaterThan(rowA.indexOf("短"));
  expect(rowA.indexOf("aa1111")).toBeGreaterThan(rowA.indexOf("model-alpha"));
});

it("会话面板删除态：选中行显示操作态（进入/删除，←→ 切换 P4-2；新建行无操作态）", async () => {
  const sessions = [{ id: "ab3f90", title: "重构 partition", model: "deepseek-v4-flash", updatedAt: "now", sizeBytes: 2048 }];
  const [modal, setModal] = createStore<ModalState>({ kind: "session", sessions, selected: 1, action: "enter" });
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 60, height: 12 });
  await setup.waitForVisualIdle();
  // 进入态：选中会话行尾显示 ◀ 进入（新建行 selected 0 无操作态）
  expect(setup.captureCharFrame()).toContain("◀ 进入");
  // ←→ 切删除态：行尾显示 ✕ 删除、键位提示同步
  setModal({ kind: "session", sessions, selected: 1, action: "delete" });
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("✕ 删除");
  expect(frame).toContain("←→ 进入/删除");
});

it("会话面板超页：窗口渲染且选中项随导航滚动入视野（新建置顶不随滚动滚出）", async () => {
  const sessions = Array.from({ length: 12 }, (_, i) => ({
    id: `sxx-${String(i).padStart(2, "0")}`,
    title: `会话 ${i}`,
    model: "m",
    updatedAt: "2026-08-27T00:00:00.000Z",
    sizeBytes: 0,
  }));
  const [modal, setModal] = createStore<ModalState>({ kind: "session", sessions, selected: 0 });
  // 大视口（每条 3 行含空行）：可见 ~7 条，12 条需窗口滚动
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 50, height: 30 });
  await setup.waitForVisualIdle();
  let frame = setup.captureCharFrame();
  expect(frame).toContain("＋ 新建会话"); // 新建置顶第一项
  expect(frame).toContain("sxx-00");
  expect(frame).not.toContain("sxx-11"); // 窗口外不渲染
  // 导航到第 10 个会话（selected 10 = 会话下标 9）：窗口滚动，9 号入视野、0 号脱离、新建仍置顶
  setModal({ kind: "session", sessions, selected: 10 });
  await setup.waitForVisualIdle();
  frame = setup.captureCharFrame();
  expect(frame).toContain("sxx-09");
  expect(frame).not.toContain("sxx-00");
  expect(frame).toContain("＋ 新建会话");
  // 底部 clamp：最末会话在视野内
  setModal({ kind: "session", sessions, selected: 12 });
  await setup.waitForVisualIdle();
  frame = setup.captureCharFrame();
  expect(frame).toContain("sxx-11");
});

it("新建会话选中态：浅蓝背景块 + 黑字（P6-4 特殊化，与普通会话白字条目区分）", async () => {
  const sessions = [
    { id: "ab3f90", title: "重构 partition", model: "m", updatedAt: "now", sizeBytes: 0 },
    { id: "cd11ef", title: "修 bug", model: "m2", updatedAt: "now", sizeBytes: 0 },
  ];
  // selected 1 = 普通会话选中：新建行无浅蓝背景
  const [modal, setModal] = createStore<ModalState>({ kind: "session", sessions, selected: 1 });
  const setup = await testRender(() => <ModalView modal={modal} />, { width: 60, height: 14 });
  await setup.waitForVisualIdle();
  let spans = setup.captureSpans().lines.flatMap((l) => l.spans);
  expect(spans.some((s) => isAccentBg(s.bg))).toBe(false);
  // selected 0 = 新建选中：＋ 新建会话 浅蓝底黑字
  setModal({ kind: "session", sessions, selected: 0 });
  await setup.waitForVisualIdle();
  spans = setup.captureSpans().lines.flatMap((l) => l.spans);
  const sel = spans.find((s) => isAccentBg(s.bg));
  expect(sel).toBeDefined();
  expect(sel!.text).toContain("＋ 新建会话");
  expect(isBlackFg(sel!.fg)).toBe(true); // 黑字（background #101013）
});
