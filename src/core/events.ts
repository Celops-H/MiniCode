/**
 * 统一流式事件：适配器将各家流式输出归一化为该事件流，主循环只消费它。
 * text / thinking / toolcall 三组 start-delta-end，结尾 done / error。
 */
export type StreamEvent =
  | { type: "text_start" }
  | { type: "text_delta"; text: string }
  | { type: "text_end" }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; thinking: string }
  | { type: "thinking_end" }
  | { type: "toolcall_start"; index: number; id?: string; name?: string }
  | { type: "toolcall_delta"; index: number; partialJson: string }
  | { type: "toolcall_end"; index: number }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };
