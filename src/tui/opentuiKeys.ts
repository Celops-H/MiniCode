/**
 * opentui 键盘事件 → MiniCode 结构键（Key）适配层。
 * opentui useKeyboard 的 KeyEvent 结构已实测：{ name, ctrl, shift, ... }。
 * 注意三点（opentui 解析行为，review 实测）：
 * - 空格解析为 name:"space"（不是 " "）；换行/回车可能是 "return" 或 "linefeed"（终端差异）
 * - A-Z 字母统一转小写、用 shift 标志还原大小写（name:"h"+shift → "H"）
 * - Ctrl+C 是打断语义；Ctrl+Shift+C 是终端复制快捷键，不进应用
 */
import type { Key } from "./keys.js";

export interface OpentuiKeyLike {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
}

export function opentuiKeyToKey(e: OpentuiKeyLike): Key {
  const { name, ctrl, shift } = e;
  if (ctrl && !shift && name === "c") return { kind: "ctrl-c" };
  if (ctrl && name === "d") return { kind: "ctrl-d" };
  switch (name) {
    case "return":
    case "linefeed":
      return { kind: shift ? "shift-enter" : "enter" };
    case "tab":
      return { kind: "tab" };
    case "escape":
      return { kind: "esc" };
    case "backspace":
      return { kind: "backspace" };
    case "delete":
      return { kind: "delete" };
    case "space":
      return { kind: "char", char: " " };
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
      // Ctrl 组合（除已映射的 c/d）不进入输入——终端快捷键/组合键
      if (ctrl) return { kind: "ignore" };
      // 普通字符：大写经 shift 标志还原（opentui 对 A-Z 统一小写）
      if (shift && /^[a-z]$/.test(name)) return { kind: "char", char: name.toUpperCase() };
      if (name.length === 1) return { kind: "char", char: name };
      return { kind: "ignore" };
  }
}