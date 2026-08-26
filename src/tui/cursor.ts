/**
 * 终端光标定位共享状态（D-1=36 光标不占格）：Prompt 渲染时写入光标应处的终端行列（1-based），
 * loop 的 postProcessFn 每帧读取并 setCursorPosition 定位原生终端光标——不再用插入字符「│」
 * 模拟（字符必占一列、移动时挤开文字）。独立文件避免 loop ↔ view 循环依赖。
 * enabled：Prompt 可见（非 connect-key 弹窗态）时 true，loop 闪烁定时器据此翻 visible 并触发重渲。
 */
export const tuiCursor: { row: number; col: number; visible: boolean; enabled: boolean } = {
  row: 1,
  col: 1,
  visible: false,
  enabled: false,
};
