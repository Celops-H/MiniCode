export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerOptions {
  /** 最小输出级别，低于此级别的消息被过滤 */
  level?: LogLevel;
  /** 完全静默，不输出任何日志 */
  silent?: boolean;
  /** 输出函数，默认 error/warn 到 stderr、其余到 stdout；测试可注入 */
  write?: (level: LogLevel, message: string) => void;
  /** 是否输出 ISO 时间戳前缀 */
  timestamp?: boolean;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly silent: boolean;
  private readonly write: (level: LogLevel, message: string) => void;
  private readonly timestamp: boolean;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.silent = options.silent ?? false;
    this.write = options.write ?? defaultWrite;
    this.timestamp = options.timestamp ?? false;
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

  /** 过滤 silent 或低于最小级别的消息，其余交给 write */
  private log(level: LogLevel, message: string): void {
    if (this.silent) return;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    this.write(level, this.format(level, message));
  }

  /** 组装输出行：可选时间戳前缀 + 级别 + 消息 */
  private format(level: LogLevel, message: string): string {
    const ts = this.timestamp ? `[${new Date().toISOString()}] ` : "";
    return `${ts}${level.toUpperCase().padEnd(5)} ${message}`;
  }
}

function defaultWrite(level: LogLevel, message: string): void {
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${message}\n`);
}
