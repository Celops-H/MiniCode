/**
 * 主题配色（P4-5 色板重映射：灰/黑/白/绿/浅蓝/红 + running 黄为进行中语义新增的第七色，E-2）。
 * 语义与 UI-SPEC 对齐：text(白正文)/textMuted(灰思考/工具)/error(红=严重/警示)/success(绿=成功、用户消息圆点与「你」标签)/
 * foregroundAccent(浅蓝=强调：弹窗选中反色块、模型圆点、子 agent 标点)/running(黄=进行中，状态行运行中、
 * 工具执行 spinner)。原橙黄不在色板内——warning 并入红（警示/严重语义）、accent 由紫改浅蓝。
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
  /** 运行中/进行中状态（E-2=66：黄色语义；红色只留严重错误/API error——色板六色外为进行中新增的黄） */
  running: "#e5c07b",
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
  /** 面板上界线（E28：面板去线框只留浅紫上界线） */
  panelTopLine: "#8b7fd4",
} as const;

export type ThemeColor = string;