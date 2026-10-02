/**
 * 可观测性模块：全本地的运行留痕系统。
 * 依赖方向单向：core 发事件 → hook 总线 ← 本模块订阅；宿主（CLI/TUI/评测）装配
 * Recorder、读数据走 TraceReader。存储独立于会话存储，只靠 sessionId 关联。
 */
import type { HookBus } from "../hooks/index.js";
import { resolveTracesDir } from "../config/paths.js";
import { Recorder, type RecorderOptions } from "./recorder.js";

export { TRACE_FORMAT, TRACE_FORMAT_VERSION, buildHeaderLine } from "./format.js";
export type { TraceHeader, TraceLine, TraceEventLine, TraceMessageLine } from "./format.js";
export { TraceWriter } from "./trace-writer.js";
export { TraceReader, deleteTrace, cleanupStaleTraces } from "./trace-reader.js";
export { Recorder } from "./recorder.js";
export type { RecorderOptions } from "./recorder.js";

/** attachRecorder 的装配选项（config.observability 字段的直通 + 宿主侧必填项） */
export interface AttachRecorderOptions {
  sessionId: string;
  cwd: string;
  minicodeVersion: string;
  /** 会话存储根目录（惰性清理用） */
  sessionsRoot: string;
  /** 轨迹目录；缺省 resolveTracesDir() */
  dir?: string;
  /** 总开关（config.observability.enabled 直通）：false 不装配、不写轨迹 */
  enabled?: boolean;
  /** header.metadata（评测宿主注入任务身份等） */
  metadata?: Record<string, unknown>;
}

/**
 * 装配轨迹记录器（CLI/TUI 宿主调用）：enabled=false 时返回
 * undefined、零开销。Recorder 订阅总线上全部事件类型，随会话存亡。
 * @param bus hook 事件总线
 * @param options 装配选项
 * @returns Recorder；总开关关闭时 undefined
 */
export function attachRecorder(bus: HookBus, options: AttachRecorderOptions): Recorder | undefined {
  if (options.enabled === false) return undefined;
  const recorderOptions: RecorderOptions = {
    sessionId: options.sessionId,
    cwd: options.cwd,
    minicodeVersion: options.minicodeVersion,
    sessionsRoot: options.sessionsRoot,
    ...(options.dir ? { dir: options.dir } : { dir: resolveTracesDir() }),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
  return new Recorder(bus, recorderOptions);
}
