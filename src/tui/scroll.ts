/**
 * 消息区滚动控制（独立模块避免 loop ↔ view 循环依赖）：
 * Messages 挂载时把 scrollbox 的滚动能力注册进来、卸载时注销；
 * 键盘滚动动作（pageup/pagedown/end/home）在 loop 的动作分发里调这里，
 * 用户提交与流式开始的强制回底也走这里。
 * 用户主动滚离底部（读历史）时 blocks 增长不把视口拽回底部，只有强制回底才解除；
 * blocks 增长的跟随回底是对 opentui sticky 吸附的兜底——内容一帧内高度跳变时
 * 吸附会被误判为手动滚动而脱附，脱附后无自愈（实测长消息后新消息被压出视口）。
 */

/** 消息区 scrollbox 需要暴露的最小滚动接口（ScrollBoxRenderable 子集，测试可注入替身） */
export interface ScrollerBox {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  /** 相对滚动：正数向下（scrollTop 增大），unit=viewport 按视口高度滚动 */
  scrollBy(delta: number, unit?: "absolute" | "viewport"): void;
  scrollToTop(): void;
  scrollToBottom(): void;
}

export const messageScroller: {
  box: ScrollerBox | null;
  /** 用户主动滚离底部（读历史中）：blocks 增长不强制回底 */
  userScrolled: boolean;
} = { box: null, userScrolled: false };

/** 是否正贴着底部（容差 1 行，opentui 吸附重入判定同款） */
function atBottom(): boolean {
  const box = messageScroller.box;
  if (!box) return true;
  const maxScrollTop = Math.max(0, box.scrollHeight - box.viewportHeight);
  return box.scrollTop >= maxScrollTop - 1;
}

/** 用户滚轮滚动后同步「是否在读历史」：向上滚 = 离开底部；向下滚回到底 = 恢复跟随 */
export function noteUserScroll(direction: "up" | "down"): void {
  if (direction === "up") {
    messageScroller.userScrolled = true;
    return;
  }
  if (atBottom()) messageScroller.userScrolled = false;
}

/** 拖滚动条等直接定位后同步「是否在读历史」：按滚动后的位置判定（不在底部 = 读历史） */
export function noteScrollPosition(): void {
  noteUserScroll(atBottom() ? "down" : "up");
}

/** 键盘翻页（pageup/pagedown，dir>0 向下）：按半个视口滚动（opentui 内置键位同款） */
export function scrollByPages(dir: number): void {
  const box = messageScroller.box;
  if (!box) return;
  box.scrollBy(dir > 0 ? 0.5 : -0.5, "viewport");
  noteUserScroll(dir > 0 ? "down" : "up");
}

/** 滚到顶部（home）：进入读历史态 */
export function scrollToTop(): void {
  messageScroller.box?.scrollToTop();
  messageScroller.userScrolled = true;
}

/** 无条件强制回底（用户提交/流式开始）：解除读历史态，sticky 恢复跟随 */
export function forceScrollToBottom(): void {
  messageScroller.userScrolled = false;
  messageScroller.box?.scrollToBottom();
}

/**
 * 视口高度变化后的跟随回底：仅跟随态（非读历史）生效。
 * 输入框长高/回落、终端改行数都会收缩/扩张消息区视口；opentui 对视口变化的自带吸附
 * 只在「内部手动滚动标记」为假时生效，该标记会被内容一帧内跳变误置位，且只有内容
 * 增长事件能自愈——空闲打字恰好没有内容事件，标记残留时视口收缩不回底，
 * 最后几行被输入框挡住。这里按本模块的跟随标记兜底回底（回落单行时同步收拢，不留空行）。
 */
export function followOnViewportResize(): void {
  if (messageScroller.userScrolled) return;
  messageScroller.box?.scrollToBottom();
}
