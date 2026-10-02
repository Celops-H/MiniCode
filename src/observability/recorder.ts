import path from "node:path";
import type { HookBus, HookEvent } from "../hooks/index.js";
import { HOOK_EVENT_TYPES } from "../hooks/index.js";
import { resolveTracesDir } from "../config/paths.js";
import { buildHeaderLine, TRACE_FORMAT, TRACE_FORMAT_VERSION, type TraceHeader } from "./format.js";
import { TraceWriter } from "./trace-writer.js";
import { cleanupStaleTraces } from "./trace-reader.js";

/** Recorder 装配选项 */
export interface RecorderOptions {
  sessionId: string;
  /** 会话工作目录（header 记录，惰性清理据此定位会话目录） */
  cwd: string;
  minicodeVersion: string;
  /** 会话存储根目录（惰性清理按各轨迹 header 的 cwd 派生会话目录） */
  sessionsRoot: string;
  /** 轨迹目录；缺省 resolveTracesDir()（~/.minicode/traces） */
  dir?: string;
  /** header.metadata（评测宿主注入任务身份等自由扩展字段）；交互场景省略 */
  metadata?: Record<string, unknown>;
  /** 攒批条数阈值（测试可注入小值观察落盘时机）；缺省 32 */
  batchSize?: number;
}

/**
 * 轨迹记录器：hook 总线的普通订阅者，收到事件与消息即转成
 * 轨迹行。镜像全部 hook 事件——新增事件自动入轨迹，采集零维护（§11 取舍 5）。
 * agent 核心（core）只发事件，不知道本模块存在；core 与 observability 之间只有
 * 事件这一条关系。
 *
 * 记账时序：handler 内同步把行文本入 writer 缓冲（到达序即发生序，与总线顺序
 * await 的语义一致），实际落盘由 writer 攒批；SessionEnd 收尾冲刷、SessionStart
 * 时做一次惰性清理兜底（§4.1）。
 */
export class Recorder {
  private readonly writer: TraceWriter;
  private readonly tracesDir: string;
  private readonly sessionId: string;
  private readonly sessionsRoot: string;
  private readonly subscriptions: Array<() => void> = [];

  /**
   * @param bus hook 事件总线（唯一采集通道）
   * @param options 装配选项
   */
  constructor(bus: HookBus, options: RecorderOptions) {
    this.tracesDir = options.dir ?? resolveTracesDir();
    this.sessionId = options.sessionId;
    this.sessionsRoot = options.sessionsRoot;
    const header: TraceHeader = {
      format: TRACE_FORMAT,
      formatVersion: TRACE_FORMAT_VERSION,
      sessionId: options.sessionId,
      cwd: options.cwd,
      minicodeVersion: options.minicodeVersion,
      startedAt: new Date().toISOString(),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    };
    this.writer = new TraceWriter(
      path.join(this.tracesDir, `${options.sessionId}.jsonl`),
      buildHeaderLine(header),
      options.batchSize,
    );
    for (const type of HOOK_EVENT_TYPES) {
      this.subscriptions.push(bus.on(type, (event) => this.record(event)));
    }
  }

  /** 全部消息行与事件行落盘（SessionEnd 自动触发；测试与宿主可显式调用） */
  async flush(): Promise<void> {
    await this.writer.flush();
  }

  /** 轨迹文件所在目录（测试断言用） */
  get dir(): string {
    return this.tracesDir;
  }

  /** 取消订阅并释放（测试收尾用；生产装配随进程存亡，无需调用） */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  /**
   * 事件→轨迹行：消息行平铺消息字段，事件行 data 携带负载（type/agentPath 提升到行级）。
   * 记账在首个 await 前同步完成（到达序=发生序）；SessionEnd 时 await 冲刷——
   * 总线顺序 await handler，宿主发完 SessionEnd 即收尾批次已落盘。
   */
  private async record(event: HookEvent): Promise<void> {
    if (event.type === "MessageAppended") {
      const { type: _type, agentPath, message } = event;
      this.writer.appendLine(JSON.stringify({ kind: "message", agentPath, ...message }));
    } else if ("agentPath" in event) {
      const { type, agentPath, ...data } = event;
      this.writeEventLine(type, agentPath, data);
    } else {
      // 无 agentPath 的会话级事件（UserPromptSubmit / SessionStart / SessionEnd）：行级省略该键
      const { type, ...data } = event;
      this.writeEventLine(type, undefined, data);
    }
    // 会话结束：冲刷收尾批次（冲刷触发点），等写完再返回
    if (event.type === "SessionEnd") await this.writer.flush();
    // 会话开始：惰性清理兜底，清掉会话文件已不存在的残留轨迹（后台进行不阻塞会话开始）
    if (event.type === "SessionStart") {
      void cleanupStaleTraces(this.tracesDir, this.sessionsRoot, this.sessionId);
    }
  }

  /** 事件行统一序列化：agentPath 缺省时行级省略该键 */
  private writeEventLine(event: string, agentPath: string | undefined, data: Record<string, unknown>): void {
    this.writer.appendLine(
      JSON.stringify({
        kind: "event",
        event,
        ...(agentPath !== undefined ? { agentPath } : {}),
        timestamp: new Date().toISOString(),
        data,
      }),
    );
  }
}
