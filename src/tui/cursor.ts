/**
 * 终端光标定位共享状态（输入法候选窗跟随）：Prompt 渲染时写入光标应处的终端行列（1-based），
 * loop 的 postProcessFn 每帧读取并 setCursorPosition 定位。光标的视觉呈现由 Prompt 渲染进
 * 文本（反色块，常亮不闪），硬件光标恒隐藏，定位仍每帧写入供输入法候选窗跟随。
 * 独立文件避免 loop ↔ view 循环依赖。
 */
export const tuiCursor: {
  row: number;
  col: number;
} = {
  row: 1,
  col: 1,
};
