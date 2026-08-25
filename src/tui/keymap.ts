/**
 * 键位映射层（纯函数）：结构键 + 当前上下文 → 高层用户动作。
 * 具体到 state 的落地（输入框/滚动/模态状态机）由 reducer 消费动作。
 */
import type { Key } from "./keys.js";

/** 高层用户动作：按键整理出的意图，state reducer 据此变更界面状态 */
export type TuiAction =
  | { type: "input"; text: string }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "send" }
  | { type: "clear-input" }
  | { type: "newline" }
  | { type: "cursor"; dir: "left" | "right" | "up" | "down" }
  | { type: "history"; dir: -1 | 1 }
  | { type: "scroll"; dir: 1 | -1 }
  | { type: "scroll-end" }
  | { type: "complete" }
  | { type: "modal-nav"; dir: 1 | -1 }
  | { type: "modal-confirm" }
  | { type: "permission"; decision: "allow" | "allow-all" | "deny" }
  | { type: "cancel" }
  | { type: "toggle-focus" }
  /** 鼠标点击指定块（下标）的折叠头：直接翻该块折叠态（Web 交互：展开/收起改鼠标点击） */
  | { type: "fold-at"; index: number }
  | { type: "interrupt" }
  | { type: "exit" }
  /** Esc：运行中打断；空闲连按两次退出（loop 层处理计时与状态） */
  | { type: "esc" }
  /** Shift+Tab 切换权限模式（一般/plan/auto） */
  | { type: "mode-cycle" }
  | { type: "noop" };

/** 键位上下文：当前有没有弹层、输入是否为空、是否在历史浏览 */
export interface KeymapContext {
  /** 输入弹层：slash 候选 / 权限或会话 modal（弹层时 Enter/↑↓/Tab 不落输入框） */
  popup?: "candidate" | "modal";
  /** 输入框是否为空（空时 ↑↓ 回溯历史；非空在框内移光标） */
  inputEmpty?: boolean;
  /** 是否正在浏览历史（已按 ↑ 载入条目后继续 ↑↓ 在历史间移动） */
  browsingHistory?: boolean;
}

export function mapKey(key: Key, ctx: KeymapContext = {}): TuiAction {
  // Shift+Tab 全局切换权限模式（正常/候选/弹窗态都生效）。
  // 注：需终端支持 kitty 键盘协议（我们开了 useKittyKeyboard）才能带 shift 标志到达；
  // 不支持的终端上 Shift+Tab 退化为 Tab 或 backtab(ignore)。
  if (key.kind === "shift-tab") return { type: "mode-cycle" };
  switch (ctx.popup) {
    case "modal":
      return mapModalKey(key);
    case "candidate":
      return mapCandidateKey(key);
    default:
      return mapNormalKey(key, ctx);
  }
}

/** normal 态（消息滚动 + 输入可用）：普通输入键直通，方向键按输入态分发 */
function mapNormalKey(key: Key, ctx: KeymapContext): TuiAction {
  switch (key.kind) {
    case "char":
      return { type: "input", text: key.char };
    case "enter":
      return { type: "send" };
    case "shift-enter":
      return { type: "newline" };
    case "tab":
      return { type: "complete" };
    case "backspace":
      return { type: "backspace" };
    case "delete":
      return { type: "delete" };
    case "left":
    case "right":
      return { type: "cursor", dir: key.kind };
    case "up":
    case "down":
      // 输入为空、或已在历史浏览中：回溯/前进历史；否则框内移光标
      return ctx.inputEmpty || ctx.browsingHistory
        ? { type: "history", dir: key.kind === "up" ? -1 : 1 }
        : { type: "cursor", dir: key.kind };
    case "pageup":
      return { type: "scroll", dir: 1 };
    case "pagedown":
      return { type: "scroll", dir: -1 };
    case "end":
      return { type: "scroll-end" };
    case "home":
      return { type: "noop" };
    case "ctrl-c":
      // Ctrl+C 弃用作打断/退出：与终端复制快捷键冲突（用户决定），改由 Esc 承担（见 esc 分支）
      return { type: "noop" };
    case "ctrl-d":
      return { type: "exit" };
    case "esc":
      // 运行中打断；空闲时连按两次退出（loop 层处理状态与计时）
      return { type: "esc" };
    case "ignore":
      return { type: "noop" };
    default:
      // shift-tab 等由 mapKey 全局拦截、或未映射键：消费不产生动作
      return { type: "noop" };
  }
}

/** modal 态（权限确认 / 会话面板）：方向键导航、Enter 确认、Esc 取消、1/2/3 权限决策；
 *  Ctrl+D 保留退出；Ctrl+C 弃用（与终端复制冲突，改 Esc 语义）。 */
function mapModalKey(key: Key): TuiAction {
  switch (key.kind) {
    case "up":
    case "left":
      return { type: "modal-nav", dir: -1 };
    case "down":
    case "right":
      return { type: "modal-nav", dir: 1 };
    case "enter":
      return { type: "modal-confirm" };
    case "esc":
      return { type: "cancel" };
    case "ctrl-c":
      return { type: "noop" };
    case "ctrl-d":
      return { type: "exit" };
    case "pageup":
      return { type: "scroll", dir: 1 };
    case "pagedown":
      return { type: "scroll", dir: -1 };
    case "char":
      if (key.char === "1") return { type: "permission", decision: "allow" };
      if (key.char === "2") return { type: "permission", decision: "allow-all" };
      if (key.char === "3") return { type: "permission", decision: "deny" };
      return { type: "noop" };
    default:
      return { type: "noop" };
  }
}

/** slash 候选态：继续打字更新查询，Tab 补全、↑↓ 选候、Enter 选中、Esc 收起 */
function mapCandidateKey(key: Key): TuiAction {
  switch (key.kind) {
    case "char":
      return { type: "input", text: key.char };
    case "backspace":
      return { type: "backspace" };
    case "tab":
      return { type: "complete" };
    case "up":
      return { type: "modal-nav", dir: -1 };
    case "down":
      return { type: "modal-nav", dir: 1 };
    case "enter":
      return { type: "modal-confirm" };
    case "esc":
      return { type: "cancel" };
    default:
      return { type: "noop" };
  }
}

/** Esc 按键的落地判定（纯函数，loop 层调用）：有折叠聚焦先取消；运行中打断；空闲双击退出 */
export function decideEsc(c: {
  hasFocus: boolean;
  running: boolean;
  lastEscAt: number;
  now: number;
  windowMs?: number;
}): "focus-clear" | "interrupt" | "arm-exit" | "exit" {
  if (c.hasFocus) return "focus-clear";
  if (c.running) return "interrupt";
  const windowMs = c.windowMs ?? 800;
  if (c.lastEscAt !== 0 && c.now - c.lastEscAt <= windowMs) return "exit";
  return "arm-exit";
}