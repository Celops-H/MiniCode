/**
 * 终端光标定位共享状态（输入法候选窗跟随）：Prompt 渲染时写入光标应处的终端行列（1-based），
 * loop 的 postProcessFn 每帧读取并 setCursorPosition 定位。光标的视觉呈现由 Prompt 渲染进
 * 文本（反色块，常亮不闪），定位仍每帧写入供输入法候选窗跟随。
 * active=false（光标不归输入框管，如 connect key 弹窗输入态）时 postProcessFn 不写定位——
 * 残留的输入框定位会把候选窗锚在输入框旧位；不写则光标格留在终端实际内容处。
 * 独立文件避免 loop ↔ view 循环依赖。
 */
export const tuiCursor: {
  row: number;
  col: number;
  /** 输入框当前是否掌管光标定位；false 时每帧不写定位 */
  active: boolean;
} = {
  row: 1,
  col: 1,
  active: true,
};

/** DECTCEM 隐藏硬件光标：只改可见性，不动光标格 */
const HIDE_CURSOR = "\x1b[?25l";

/** 接线所需的最小渲染器接口（CliRenderer 子集，测试可注入替身） */
export interface CursorRenderer {
  addPostProcessFn(fn: () => void): void;
  on(event: "frame", listener: () => void): void;
  setCursorPosition(x: number, y: number, visible?: boolean): void;
}

/**
 * 硬件光标定位接线：每帧把光标写到输入框光标处，写完后立刻隐藏。
 *
 * 定位必须按 visible=true 调 setCursorPosition。opentui 只在 visible=true 时写出定位转义
 * （CUP）；visible=false 只发隐藏转义、不写位置。终端按光标格摆放输入法候选窗，位置不写出
 * 时候选窗停在上一帧最后一次写入的字符处——输入框为空时没有可写内容，候选窗就落在别处；
 * 先输入若干字符后，每帧的差量重绘恰好把光标留在输入框行，看起来正常。
 *
 * 隐藏由帧末补发 DECTCEM 完成：隐藏不改光标格，候选窗仍锚在输入框光标处，硬件光标本身不显示，
 * 视觉光标由 Prompt 渲染的反色块承担。补发挂在 frame 事件上，该事件在原生帧写出之后发出，
 * 所以测试路径下最后生效的是隐藏；真机的字节时序与退出后的光标可见性见 request.md T36。
 * write 由调用方传入终端输出流：CliRenderer 的 stdout 在类型上是私有的，渲染器也不对外
 * 提供补发接口。
 */
export function attachCursorPositioning(renderer: CursorRenderer, write: (chunk: string) => void): void {
  renderer.addPostProcessFn(() => {
    if (!tuiCursor.active) return; // 光标不归输入框管：不写定位，光标格留在终端实际内容处
    renderer.setCursorPosition(tuiCursor.col, tuiCursor.row, true);
  });
  renderer.on("frame", () => {
    write(HIDE_CURSOR);
  });
}
