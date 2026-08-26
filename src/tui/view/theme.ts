/**
 * 主题配色（P4-5 色板重映射，用户指定六色：灰、黑、白、绿、浅蓝、红）。
 * 语义与 UI-SPEC 对齐：text(白)/textMuted(灰)/error(红)/success(绿)/accent(浅蓝)/
 * 运行中提示浅蓝。原橙黄与强调紫不在色板内——warning 并入红（警示/严重语义）、
 * accent 由紫改浅蓝（菜单选中、用户消息圆点、子 agent 标点等统一强调色）。
 * 弹框与主区背景统一更深黑（用户：弹窗块和消息历史背景同色），hover 抬高一档。
 */
export const theme = {
  text: "#ececf0",
  textMuted: "#8f9096",
  error: "#e06c75",
  /** 警示/严重提示（用户色板无独立警告色：红色承担严重与警告双重语义） */
  warning: "#e06c75",
  success: "#7fd88f",
  /** 强调色（选中项、用户消息圆点、子 agent 标点等）——色板浅蓝 */
  foregroundAccent: "#61afef",
  /** 模型消息点标记（模型蓝）——与灰（工具/思考/子agent）、红（错误）区分 */
  modelColor: "#61afef",
  /** 界面背景（窗口底色，更深的黑） */
  background: "#101013",
  /** 面板/局部区块背景（P4-5：与主区背景统一一个颜色） */
  backgroundPanel: "#101013",
  /** 更深一层背景上的抬高态（选中 chip、悬停高亮） */
  backgroundRaised: "#1c1c22",
  /** 普通边框 */
  border: "#333338",
  /** 焦点/高亮边框 */
  borderActive: "#4a4a52",
  /** 弱化边框（消息分隔等细腻线） */
  borderSubtle: "#26262b",
} as const;

export type ThemeColor = string;