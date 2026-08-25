/**
 * opentui 键盘事件 → MiniCode 结构键（Key）适配层。
 * opentui useKeyboard 的 KeyEvent 结构已实测：{ name, ctrl, shift, ... }，
 * 普通字符 name 为字符本身，功能键用标准名（return/up/down/left/right/escape…）。
 * 用最小结构类型承接，避免与 @opentui/core 内部 KeyEvent 类型强耦合。
 */
import type { Key } from "./keys.js";

export interface OpentuiKeyLike {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
}

export function opentuiKeyToKey(e: OpentuiKeyLike): Key {
  const { name, ctrl, shift } = e;
  if (ctrl && name === "c") return { kind: "ctrl-c" };
  if (ctrl && name === "d") return { kind: "ctrl-d" };
  switch (name) {
    case "return":
      return { kind: shift ? "shift-enter" : "enter" };
    case "tab":
      return { kind: "tab" };
    case "escape":
      return { kind: "esc" };
    case "backspace":
      return { kind: "backspace" };
    case "delete":
      return { kind: "delete" };
    case "up":
    case "down":
    case "left":
    case "right":
      return { kind: name };
    case "pageup":
      return { kind: "pageup" };
    case "pagedown":
      return { kind: "pagedown" };
    case "home":
      return { kind: "home" };
    case "end":
      return { kind: "end" };
    default:
      // 普通字符（含中文等 IME 分段的单码点）：name 即字符本身
      if (name.length === 1) return { kind: "char", char: name };
      return { kind: "ignore" };
  }
}