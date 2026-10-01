import { existsSync, appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 单文件字节数上限缺省值：超过轮转为 .old（OBSERVABILITY §6，保留一份） */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** 流水日志文件选项（OBSERVABILITY §6） */
export interface LoggerFileOptions {
  /** 日志文件路径（~/.minicode/logs/minicode.log） */
  path: string;
  /** 单文件字节数上限，超过轮转为 <path>.old（保留一份）；缺省 5MB */
  maxBytes?: number;
}

export interface LoggerOptions {
  /** 最小输出级别，低于此级别的消息被过滤 */
  level?: LogLevel;
  /** 完全静默，不输出任何日志 */
  silent?: boolean;
  /** 输出函数，默认 error/warn 到 stderr、其余到 stdout；测试可注入 */
  write?: (level: LogLevel, message: string) => void;
  /** 是否输出 ISO 时间戳前缀 */
  timestamp?: boolean;
  /**
   * 流水日志文件：配置后日志写文件（不再走控制台 write），文件行恒带时间戳；
   * 单文件超限轮转保留 .old 一份。写失败（权限/磁盘）静默降级，不干扰业务。
   */
  file?: LoggerFileOptions;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly silent: boolean;
  private readonly write: (level: LogLevel, message: string) => void;
  private readonly timestamp: boolean;
  private readonly file?: LoggerFileOptions;
  /** 文件当前字节数（null = 尚未初始化，首次写时 stat 一次） */
  private fileBytes: number | null = null;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.silent = options.silent ?? false;
    this.write = options.write ?? defaultWrite;
    this.timestamp = options.timestamp ?? false;
    this.file = options.file;
  }

  /**
   * 输出 debug 级日志。
   * @param message 日志内容
   */
  debug(message: string): void {
    this.log("debug", message);
  }

  /**
   * 输出 info 级日志。
   * @param message 日志内容
   */
  info(message: string): void {
    this.log("info", message);
  }

  /**
   * 输出 warn 级日志。
   * @param message 日志内容
   */
  warn(message: string): void {
    this.log("warn", message);
  }

  /**
   * 输出 error 级日志。
   * @param message 日志内容
   */
  error(message: string): void {
    this.log("error", message);
  }

  /** 过滤 silent 或低于最小级别的消息，其余交给 write 或写文件 */
  private log(level: LogLevel, message: string): void {
    if (this.silent) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    if (this.file) {
      // 文件行恒带时间戳（流水日志给人翻，时间不可省）
      this.writeToFile(`[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${message}`);
      return;
    }
    this.write(level, this.format(level, message));
  }

  /** 组装输出行：可选时间戳前缀 + 级别 + 消息 */
  private format(level: LogLevel, message: string): string {
    const ts = this.timestamp ? `[${new Date().toISOString()}] ` : "";
    return `${ts}${level.toUpperCase().padEnd(5)} ${message}`;
  }

  /** 追加一行到日志文件，超限先轮转；任何 IO 失败静默降级（观测数据不反噬业务） */
  private writeToFile(line: string): void {
    const target = this.file!;
    try {
      if (this.fileBytes === null) {
        this.fileBytes = existsSync(target.path) ? statSync(target.path).size : 0;
      }
      const lineBytes = Buffer.byteLength(line, "utf8") + 1; // 含换行
      const limit = target.maxBytes ?? DEFAULT_MAX_BYTES;
      if (this.fileBytes > 0 && this.fileBytes + lineBytes > limit) {
        this.rotate();
      }
      mkdirSync(path.dirname(target.path), { recursive: true, mode: 0o700 });
      appendFileSync(target.path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
      this.fileBytes += lineBytes;
    } catch {
      // 轮转/写入失败（文件被占用、权限、磁盘满）：跳过本轮，不影响业务流程
    }
  }

  /** 轮转：当前文件改名 .old（旧 .old 删除，只保留一份），字节数归零 */
  private rotate(): void {
    const target = this.file!;
    try {
      rmSync(`${target.path}.old`, { force: true });
      renameSync(target.path, `${target.path}.old`);
    } catch {
      // 改名失败（Windows 上文件被未共享删除句柄的程序打开等）：保留字节数计，
      // 下次写入按真实大小重试轮转——若归零计数，真实文件可长到约两倍上限才重试
      return;
    }
    this.fileBytes = 0;
  }
}

function defaultWrite(level: LogLevel, message: string): void {
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${message}\n`);
}
