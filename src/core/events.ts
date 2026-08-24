/**
 * 统一流式事件：适配器将各家流式输出归一化为该事件流，主循环只消费它。
 * text / thinking 以 delta 增量到达（TUI 渲染累积即可，无需 start/end）；
 * toolcall 三组 start-delta-end（start 携带工具名与 id，标记调用边界；
 * 同一 index 可能重复 start——id/name 后补时（OpenAI 兼容厂商先发参数后补 id），
 * 消费端取最后一次的值）。
 * 结尾必达 done（正常停因）或 error（流错误）。error 三条来源：
 * 厂商 API 错误事件（不抛异常）、流意外结束（不抛）、流中断异常
 * （yield error 后原样抛出供控制流处理，剥组重试等）。
 * 消费端约定：error 事件后不得中断迭代（未消费完的异常会被吞），必须继续消费到流结束。
 */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "toolcall_start"; index: number; id?: string; name?: string }
  | { type: "toolcall_delta"; index: number; partialJson: string }
  | { type: "toolcall_end"; index: number }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };