/**
 * 结构键类型：原始终端字节（含转义序列）整理成的含义明确的键。
 * 原本在渲染层 terminal.ts 内定义，重写后渲染改 opentui，按键类型独立成文件供 keymap/loop/view 共用。
 */
export type Key =
  | { kind: "char"; char: string }
  | { kind: "enter" }
  | { kind: "shift-enter" }
  | { kind: "tab" }
  | { kind: "shift-tab" }
  | { kind: "esc" }
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "pageup" }
  | { kind: "pagedown" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "ctrl-c" }
  | { kind: "ctrl-d" }
  /** 不支持的转义序列（鼠标、组合键等），消费掉但不产生键 */
  | { kind: "ignore" };