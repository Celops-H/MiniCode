/**
 * 层 1：键位映射（keymap）——normal/modal/candidate 三种上下文。
 * 覆盖 M4.4 阶段审视发现的语义回归区（modal/candidate 的 Enter/Tab/1/a/d）。
 */
import { it, expect } from "vitest";
import { mapKey, decideEsc } from "../../src/tui/keymap.js";

it("normal 态：字符→input、回车→send、Esc→esc、Ctrl+C→noop（弃用）、Ctrl+D→exit", () => {
  expect(mapKey({ kind: "char", char: "a" })).toEqual({ type: "input", text: "a" });
  expect(mapKey({ kind: "enter" })).toEqual({ type: "send" });
  // Esc 承担打断/双击退出；ctrl+c 弃用（与终端复制冲突）
  expect(mapKey({ kind: "esc" })).toEqual({ type: "esc" });
  expect(mapKey({ kind: "ctrl-c" })).toEqual({ type: "noop" });
  expect(mapKey({ kind: "ctrl-d" })).toEqual({ type: "exit" });
  expect(mapKey({ kind: "pageup" })).toEqual({ type: "scroll", dir: 1 });
});

it("modal 态：1/2/3→权限决策、Esc→取消、Ctrl+C 弃用、Ctrl+D 保留退出", () => {
  const m = { popup: "modal" as const };
  expect(mapKey({ kind: "char", char: "1" }, m)).toEqual({ type: "permission", decision: "allow" });
  expect(mapKey({ kind: "char", char: "2" }, m)).toEqual({ type: "permission", decision: "allow-all" });
  expect(mapKey({ kind: "char", char: "3" }, m)).toEqual({ type: "permission", decision: "deny" });
  expect(mapKey({ kind: "esc" }, m)).toEqual({ type: "cancel" });
  expect(mapKey({ kind: "ctrl-c" }, m)).toEqual({ type: "noop" });
  expect(mapKey({ kind: "ctrl-d" }, m)).toEqual({ type: "exit" });
  expect(mapKey({ kind: "up" }, m)).toEqual({ type: "modal-nav", dir: -1 });
});

it("candidate 态：回车→modal-confirm（执行选中命令）、Tab→complete、Esc→cancel", () => {
  const c = { popup: "candidate" as const };
  expect(mapKey({ kind: "enter" }, c)).toEqual({ type: "modal-confirm" });
  expect(mapKey({ kind: "tab" }, c)).toEqual({ type: "complete" });
  expect(mapKey({ kind: "esc" }, c)).toEqual({ type: "cancel" });
  expect(mapKey({ kind: "up" }, c)).toEqual({ type: "modal-nav", dir: -1 });
});

it("model 弹窗：↑↓ 选模型、←→ 调思考等级、Enter 应用", () => {
  const m = { popup: "modal" as const, modalKind: "model" as const };
  expect(mapKey({ kind: "up" }, m)).toEqual({ type: "modal-nav", dir: -1 });
  expect(mapKey({ kind: "left" }, m)).toEqual({ type: "thinking-adjust", dir: -1 });
  expect(mapKey({ kind: "right" }, m)).toEqual({ type: "thinking-adjust", dir: 1 });
  expect(mapKey({ kind: "enter" }, m)).toEqual({ type: "modal-confirm" });
  expect(mapKey({ kind: "esc" }, m)).toEqual({ type: "cancel" });
});

it("decideEsc：聚焦先取消 → 运行中打断 → 空闲双击退出", () => {
  // 有折叠聚焦：取消聚焦优先
  expect(decideEsc({ hasFocus: true, running: true, lastEscAt: 0, now: 0 })).toBe("focus-clear");
  // 运行中：打断（不消耗计时）
  expect(decideEsc({ hasFocus: false, running: true, lastEscAt: 0, now: 0 })).toBe("interrupt");
  // 空闲第一次：arm
  expect(decideEsc({ hasFocus: false, running: false, lastEscAt: 0, now: 0 })).toBe("arm-exit");
  // 空闲窗口内第二次：退出
  expect(decideEsc({ hasFocus: false, running: false, lastEscAt: 100, now: 400, windowMs: 800 })).toBe("exit");
  // 超窗：重新 arm
  expect(decideEsc({ hasFocus: false, running: false, lastEscAt: 100, now: 1000, windowMs: 800 })).toBe("arm-exit");
});