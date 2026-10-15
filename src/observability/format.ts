/**
 * 轨迹格式（本文即接口文档）：JSONL 一行一条，首行 header，
 * 之后消息行与事件行两类，`kind` 字段区分。读取按 kind 分流，未知 kind/event
 * 跳过不报错（事件类型是开放清单，前向兼容靠这条）。
 *
 * 顺序与时间戳：行序才是因果序，消费方按文件行序读，不按 timestamp 排序。
 * 两类行的 timestamp 语义不同——事件行记采集时刻，消息行记消息自身创建时刻；
 * 二者交错写入，文件序里 timestamp 允许回退。
 */

/** header 的 format 标识 */
export const TRACE_FORMAT = "minicode-trace";
/** 格式版本：字段只增不改，格式演进升版本号 */
export const TRACE_FORMAT_VERSION = 1;

/**
 * 轨迹首行 header：定长字段今后不再增加，扩展一律走 metadata
 * （评测宿主注入任务身份：数据集名、题目 id、run id、尝试序号等）。
 */
export interface TraceHeader {
  format: string;
  formatVersion: number;
  sessionId: string;
  cwd: string;
  minicodeVersion: string;
  startedAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * 消息行：复用会话文件的消息结构原样嵌入（不发明第二套消息 schema），
 * 加 agentPath 标注归属（根 agent 为 /root）。消息自身字段（role/id/content/
 * meta/source/toolCallId 等）按原样平铺在行级。
 * 行级 timestamp 取消息自身的创建时刻，与事件行的采集时刻语义不同。
 */
export interface TraceMessageLine {
  kind: "message";
  agentPath: string;
  /** 与统一消息模型的四类角色一致（error 为出错轮的界面留痕记录） */
  role: "user" | "assistant" | "tool_result" | "error";
  id: string;
  timestamp?: string;
  [key: string]: unknown;
}

/**
 * 事件行：与 hook 事件同名同构（零映射），data 为事件负载（type 与 agentPath
 * 提升到行级）。行级 timestamp 是采集时刻，由 Recorder 收到事件时打
 * （总线顺序 await，到达序即发生序）；它不保证随文件序单调，因果序只看行序。
 * agentPath 由 Recorder 恒写（payload 不带路径的会话级事件归 /root），行级必有值。
 */
export interface TraceEventLine {
  kind: "event";
  event: string;
  agentPath: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/** 轨迹行：header 之外按 kind 分流的两类 */
export type TraceLine = TraceMessageLine | TraceEventLine;

/**
 * 构建 header 行文本（Recorder 落盘首行用）。
 * @param header header 内容（metadata 未提供时省略该键，交互场景可省略）
 * @returns 序列化后的 header 行（不含换行符）
 */
export function buildHeaderLine(header: TraceHeader): string {
  return JSON.stringify(header);
}
