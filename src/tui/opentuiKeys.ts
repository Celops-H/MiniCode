/**
 * opentui 键盘事件 → MiniCode 结构键（Key）适配层。
 * opentui useKeyboard 的 KeyEvent 结构已实测：{ name, ctrl, shift, ... }。
 * 注意三点（opentui 解析行为，review 实测）：
 * - 空格解析为 name:"space"（不是 " "）；换行/回车可能是 "return" 或 "linefeed"（终端差异），
 *   终端忽略 kitty disambiguate 时还可能是 LF/CR 码点 "\n"/"\r"（见 switch 的对应分支）
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
    case "\n":
    case "\r":
      // Enter 发送；Shift+Enter 或 Ctrl+Enter/Ctrl+J 走软换行（主流编辑器习惯）。
      // \n / \r 码点分支：部分终端忽略 kitty disambiguate、把 Ctrl+J 按控制字符码点上报
      // （name:"\n"+ctrl）——此前被 default 的 ctrl 分支当组合键 ignore（换行静默失效）；
      // 裸 "\n" 则会被当普通字符 insertText 进单行，破坏多行 prompt。统一按回车/换行语义走。
      return { kind: ctrl || shift ? "shift-enter" : "enter" };
    case "j":
      // Ctrl+J 换行（kitty 键盘协议下 ctrl+j 带 ctrl 标志独立到达）
      if (ctrl) return { kind: "shift-enter" };
      return { kind: "char", char: "j" };
    case "tab":
      return { kind: shift ? "shift-tab" : "tab" };
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