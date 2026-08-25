/**
 * 主题配色（对齐 opencode 深色基线的提炼版）。
 * 语义与 UI-SPEC/opencode 对齐：text/textMuted/error/warning/success/accent(紫)/三档背景/三档边框。
 * 组件按语义取色，不写死色值；后续要换主题只改这一处。
 */
export const theme = {
  text: "#ececf0",
  textMuted: "#8f9096",
  error: "#e06c75",
  warning: "#f0a94a",
  success: "#7fd88f",
  /** 强调色（选中项、子 agent 标点、链接等）——opencode accent 紫 */
  foregroundAccent: "#9d7cd8",
  /** 界面背景（窗口底色） */
  background: "#16161a",
  /** 面板/局部区块背景（弹块、工具卡、输入区提亮） */
  backgroundPanel: "#222228",
  /** 更深一层背景（选中 chip、hover 等抬高） */
  backgroundRaised: "#2c2c34",
  /** 普通边框 */
  border: "#3d3d44",
  /** 焦点/高亮边框 */
  borderActive: "#5f5f6a",
  /** 弱化边框（消息分隔等细腻线） */
  borderSubtle: "#2b2b31",
} as const;

export type ThemeColor = string;