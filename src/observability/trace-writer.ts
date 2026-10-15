import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/** 攒批条数阈值：缓冲达到即触发一次异步落盘 */
const DEFAULT_BATCH_SIZE = 32;

/**
 * 进程级收尾冲刷登记：登记表只覆盖「缓冲里还有未落盘行」的 writer——写入时登记，
 * 冲刷干净或 dispose 后摘除。exit/信号处理器只装一次，收尾时同步冲刷全部残余缓冲。
 * 跨会话轮换（TUI reconfigure 每轮新建 writer）不再把历史 writer 累积到进程收尾；
 * 会话收尾后仍有迟到行写入的 writer（团队收尾后在途驱动的子 agent 终态事件）重新登记，
 * 残余照旧由进程收尾冲刷，不丢行。
 */
const liveWriters = new Set<TraceWriter>();
let processHooksInstalled = false;

/** 冲刷全部存活 writer 的残余缓冲（exit 处理器与信号处理器共用） */
function flushAllWriters(): void {
  for (const writer of liveWriters) writer.flushSync();
}

/** 登记表条目数（含未落盘行的 writer；测试观测摘除是否生效） */
export function liveWriterCount(): number {
  return liveWriters.size;
}

/**
 * 信号处理：冲刷后摘除自身监听再按原信号重发——保留「进程被信号终止」的语义，
 * 也不抢占宿主（评测场景 Recorder 装配在评测进程内）后注册的同信号清理流程。
 * 重发时本模块监听已摘除，不会自递归。
 */
function signalHandler(signal: NodeJS.Signals): void {
  flushAllWriters();
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  try {
    process.kill(process.pid, signal);
  } catch {
    // 平台不支持自发自收信号时按失败收尾（exit 处理器仍会执行，残余缓冲已冲刷过）
    process.exit(1);
  }
}
const onSignal = (signal: NodeJS.Signals): void => signalHandler(signal);

/** 安装进程级收尾冲刷（幂等）：正常退出与 SIGINT/SIGTERM 信号都不丢收尾批次 */
function installProcessFlushHooks(): void {
  if (processHooksInstalled) return;
  processHooksInstalled = true;
  process.on("exit", flushAllWriters);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

/**
 * 轨迹文件追加写：只追加、永不改写；写入攒批（条数阈值），
 * SessionEnd / 进程正常退出 / SIGINT、SIGTERM 信号时冲刷。append-only 使崩溃
 * 最多丢最后一批，不会损坏已有内容。文件权限 0600（会话轨迹含正文，属用户隐私）。
 */
export class TraceWriter {
  private readonly buffer: string[] = [];
  /** header 是否已入队（首条记录前先写 header；续跑的轨迹文件已有 header 则不重复插） */
  private headerQueued = false;
  /**
   * flush 串行链：阈值触发的 flush 与收尾冲刷可能并发，同一文件两次并发 append
   * 会批次乱序甚至行中间交错（O_APPEND 只保证单次 write 原子，大批次拆多次 syscall
   * 时可被并发句柄插入），破坏到达序与 append-only 完整性——链式排队后同一时刻
   * 只有一次写，失败回填缓冲头的顺序语义也随之恢复正确
   */
  private flushChain: Promise<void> = Promise.resolve();

  /**
   * @param filePath 轨迹文件路径（<tracesDir>/<sessionId>.jsonl）
   * @param headerLine 首行 header（Recorder 构建）
   * @param batchSize 攒批条数阈值（测试可注入小值观察落盘时机）
   */
  constructor(
    private readonly filePath: string,
    private readonly headerLine: string,
    private readonly batchSize: number = DEFAULT_BATCH_SIZE,
  ) {
    installProcessFlushHooks();
  }

  /**
   * 追加一行（同步记账进缓冲）：调用即同步入队保证到达序=发生序，
   * 实际落盘攒批到阈值或冲刷时才发生。有未落盘行即入收尾登记
   * （dispose 或冲刷干净后摘除，见各自注释）。
   * @param line 序列化好的轨迹行（不含换行符）
   */
  appendLine(line: string): void {
    if (!this.headerQueued) {
      // 续跑的会话轨迹文件已存在（首行已有 header）：只追加、不重复插 header
      if (!existsSync(this.filePath)) this.buffer.push(this.headerLine);
      this.headerQueued = true;
    }
    this.buffer.push(line);
    liveWriters.add(this);
    if (this.buffer.length >= this.batchSize) void this.flush();
  }

  /**
   * 异步冲刷：排队到串行链尾执行。落盘失败把批次放回缓冲头部（顺序不乱、
   * 下次冲刷重试）——轨迹是观测数据，IO 故障不反噬业务流程。
   */
  flush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.doFlush());
    return this.flushChain;
  }

  /** 串行链上的单次写（同一时刻至多一次 append）；写空即摘除收尾登记 */
  private async doFlush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await appendFile(this.filePath, `${batch.join("\n")}\n`, { mode: 0o600, encoding: "utf8" });
      // 写空且写期间无新行入队才摘除：新行入队时已重新登记
      if (this.buffer.length === 0) liveWriters.delete(this);
    } catch {
      this.buffer.unshift(...batch);
    }
  }

  /**
   * 同步冲刷（进程 exit / 信号处理器用：exit 处理器只能同步 IO）。
   * 失败处理同 flush：批次放回缓冲（此时进程将终止，等价于丢最后一批——
   * append-only 设计下已有内容不受损）。写空同样摘除收尾登记。
   */
  flushSync(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      appendFileSync(this.filePath, `${batch.join("\n")}\n`, { mode: 0o600 });
      if (this.buffer.length === 0) liveWriters.delete(this);
    } catch {
      this.buffer.unshift(...batch);
    }
  }

  /**
   * 释放：冲刷残余缓冲并摘除收尾登记（Recorder.dispose 调用，与会话收尾同链）。
   * 摘除后进程收尾不再冲刷本 writer，故先冲刷；冲刷失败（残余已回填缓冲）时保留登记，
   * 残余交进程收尾再试一次，不因释放丢行。
   */
  dispose(): void {
    this.flushSync();
  }
}
