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
  /** Shift+方向键：扩展输入框选区（B-2，需终端带 shift 修饰标志上报，kitty 协议下可靠） */
  | { kind: "shift-up" }
  | { kind: "shift-down" }
  | { kind: "shift-left" }
  | { kind: "shift-right" }
  | { kind: "pageup" }
  | { kind: "pagedown" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "ctrl-c" }
  | { kind: "ctrl-d" }
  /** 输入编辑键（emacs 系习惯）：Ctrl+A/E 行首尾、U 删整行、K 删到行尾、W 删前词 */
  | { kind: "ctrl-a" }
  | { kind: "ctrl-e" }
  | { kind: "ctrl-u" }
  | { kind: "ctrl-k" }
  | { kind: "ctrl-w" }
  /** 不支持的转义序列（鼠标、组合键等），消费掉但不产生键 */
  | { kind: "ignore" };