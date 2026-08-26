/**
 * opentui 键盘事件 → MiniCode 结构键（Key）适配层。
 * opentui useKeyboard 的 KeyEvent 结构已实测：{ name, ctrl, shift, ... }。
 * 注意三点（opentui 解析行为，review 实测 + 源码核对 chunk-node-mfda59vq.js parseKeypress）：
 * - 空格解析为 name:"space"（不是 " "）；Enter 键（CR \r）解析为 "return"、Ctrl+J（LF \n）解析为
 *   "linefeed"（无 ctrl 标志）；终端忽略 kitty disambiguate 时还可能是裸码点 "\n"/"\r"（见 switch 分支）
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
    case "\r":
      // Enter 发送（标准终端 Enter 键发 CR \r → opentui 解析为 return/\r）；Shift/Ctrl 组合走软换行。
      return { kind: ctrl || shift ? "shift-enter" : "enter" };
    case "linefeed":
    case "\n":
      // LF = Ctrl+J：无 kitty 协议时 opentui 把 0x0A 解析为 name:"linefeed"（无 ctrl 标志，
      //   parseKeypress 源码 CR→return、LF→linefeed，见 chunk-node-mfda59vq.js）——此前把 linefeed
      //   归入发送组导致真机 Ctrl+J 仍发送（层1测试用 {name:"j",ctrl} 全绿但真机不生效）；
      //   统一按软换行。裸 \n 码点（忽略 kitty 的终端上报）同样软换行，Enter 走 return/\r 不受影响。
      return { kind: "shift-enter" };
    case "j":
      // Ctrl+J 换行（kitty 键盘协议下 ctrl+j 带 ctrl 标志独立到达）
      if (ctrl) return { kind: "shift-enter" };
      // 无 ctrl 时与 default 一致：shift 还原大写（opentui 对 A-Z 统一小写上报 + shift 标志）
      return shift ? { kind: "char", char: "J" } : { kind: "char", char: "j" };
    case "a":
      if (ctrl) return { kind: "ctrl-a" };
      return shift ? { kind: "char", char: "A" } : { kind: "char", char: "a" };
    case "e":
      if (ctrl) return { kind: "ctrl-e" };
      return shift ? { kind: "char", char: "E" } : { kind: "char", char: "e" };
    case "u":
      if (ctrl && shift) return { kind: "ctrl-shift-u" };
      if (ctrl) return { kind: "ctrl-u" };
      return shift ? { kind: "char", char: "U" } : { kind: "char", char: "u" };
    case "k":
      if (ctrl) return { kind: "ctrl-k" };
      return shift ? { kind: "char", char: "K" } : { kind: "char", char: "k" };
    case "w":
      if (ctrl) return { kind: "ctrl-w" };
      return shift ? { kind: "char", char: "W" } : { kind: "char", char: "w" };
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
      // Shift+方向键保留修饰：输入框扩展选区（B-2）；kitty 协议下 shift 标志可靠到达
      if (shift) return { kind: `shift-${name}` as "shift-left" | "shift-right" | "shift-up" | "shift-down" };
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