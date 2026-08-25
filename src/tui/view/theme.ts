/**
 * 主题配色（R1 基础版）：对齐 opencode 观感基线（text/textMuted/error/warning/success）。
 * opentui 的 fg/bg 接受字符串颜色或 RGBA；R5 打磨时按 opencode theme（含背景/边框/高亮）细调。
 */
export const theme = {
  text: "#e3e3e8",
  textMuted: "#8a8a92",
  error: "#ec6068",
  warning: "#f4b357",
  success: "#52d691",
  foregroundAccent: "#9886ff",
  /** 界面背景（opencode 风格深色底） */
  background: "#1a1a1c",
  /** 面板/元素背景（弹块、工具卡等局部提亮） */
  backgroundPanel: "#252527",
} as const;

export type ThemeColor = string;