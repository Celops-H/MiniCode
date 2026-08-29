/**
 * 终端光标定位共享状态（D-1=36 光标不占格）：Prompt 渲染时写入光标应处的终端行列（1-based），
 * loop 的 postProcessFn 每帧读取并 setCursorPosition 定位原生终端光标——不再用插入字符「│」
 * 模拟（字符必占一列、移动时挤开文字）。独立文件避免 loop ↔ view 循环依赖。
 * enabled：Prompt 可见（非 connect-key 弹窗态）时 true，loop 闪烁定时器据此翻 visible 并触发重渲。
 * lastMoveAt：最近一次光标移动时刻（E39）——闪烁定时器据此实现「移动后短暂常亮、停驻才闪烁」，
 * 移动过程不被闪烁相位打断（打字/移动时光标持续可见）。
 */
export const tuiCursor: {
  row: number;
  col: number;
  visible: boolean;
  enabled: boolean;
  lastMoveAt: number;
} = {
  row: 1,
  col: 1,
  visible: false,
  enabled: false,
  lastMoveAt: 0,
};

/** 光标移动常亮的宽限窗（毫秒）：窗口内闪烁定时器保持常亮，过期后恢复闪烁相位（E39） */
export const CURSOR_STEADY_MS = 500;
