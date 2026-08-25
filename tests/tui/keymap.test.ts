/**
 * 层 1：键位映射（keymap）——normal/modal/candidate 三种上下文。
 * 覆盖 M4.4 阶段审视发现的语义回归区（modal/candidate 的 Enter/Tab/1/a/d）。
 */
import { it, expect } from "vitest";
import { mapKey } from "../../src/tui/keymap.js";

it("normal 态：字符→input、回车→send、Ctrl+C→interrupt、Ctrl+D→exit", () => {
  expect(mapKey({ kind: "char", char: "a" })).toEqual({ type: "input", text: "a" });
  expect(mapKey({ kind: "enter" })).toEqual({ type: "send" });
  expect(mapKey({ kind: "ctrl-c" })).toEqual({ type: "interrupt" });
  expect(mapKey({ kind: "ctrl-d" })).toEqual({ type: "exit" });
  expect(mapKey({ kind: "pageup" })).toEqual({ type: "scroll", dir: 1 });
});

it("modal 态：1/a/d→权限决策、Esc→cancel、Ctrl+C/D 保留打断/退出", () => {
  const m = { popup: "modal" as const };
  expect(mapKey({ kind: "char", char: "1" }, m)).toEqual({ type: "permission", decision: "allow" });
  expect(mapKey({ kind: "char", char: "a" }, m)).toEqual({ type: "permission", decision: "allow-all" });
  expect(mapKey({ kind: "char", char: "d" }, m)).toEqual({ type: "permission", decision: "deny" });
  expect(mapKey({ kind: "esc" }, m)).toEqual({ type: "cancel" });
  expect(mapKey({ kind: "ctrl-c" }, m)).toEqual({ type: "interrupt" });
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