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
  | { type: "toggle-fold" }
  | { type: "interrupt" }
  | { type: "exit" }
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
      return { type: "interrupt" };
    case "ctrl-d":
      return { type: "exit" };
    case "esc":
      return { type: "cancel" };
    case "ignore":
      return { type: "noop" };
  }
}

/** modal 态（权限确认 / 会话面板）：方向键导航、Enter 确认、Esc 取消、1/a/d 权限决策；
 *  Ctrl+C/D 仍响应（打断/退出作用到待批审批——否则审批弹窗会吞掉打断键，卡死的工具救不了） */
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
      return { type: "interrupt" };
    case "ctrl-d":
      return { type: "exit" };
    case "pageup":
      return { type: "scroll", dir: 1 };
    case "pagedown":
      return { type: "scroll", dir: -1 };
    case "char":
      if (key.char === "1") return { type: "permission", decision: "allow" };
      if (key.char === "a") return { type: "permission", decision: "allow-all" };
      if (key.char === "d") return { type: "permission", decision: "deny" };
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