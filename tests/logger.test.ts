import { afterEach, describe, expect, it, vi } from "vitest";
import { LOG_LEVELS, Logger } from "../src/logger/index.js";
import type { LogLevel } from "../src/logger/index.js";

describe("Logger", () => {
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
  });

  function capture() {
    const writes: Array<{ level: LogLevel; message: string }> = [];
    const write = (level: LogLevel, message: string) => writes.push({ level, message });
    return { writes, write };
  }

  it("默认级别 info：debug 被过滤，info 输出", () => {
    const { writes, write } = capture();
    const logger = new Logger({ write });
    logger.debug("低");
    logger.info("中");
    expect(writes).toEqual([{ level: "info", message: expect.stringContaining("中") }]);
  });

  it("按级别过滤：warn 级别时仅输出 warn 与 error", () => {
    const { writes, write } = capture();
    const logger = new Logger({ level: "warn", write });
    logger.info("中");
    logger.warn("高");
    logger.error("更高");
    expect(writes.map((w) => w.level)).toEqual(["warn", "error"]);
  });

  it("silent 时不输出任何日志", () => {
    const { writes, write } = capture();
    const logger = new Logger({ silent: true, write });
    logger.error("更");
    expect(writes).toEqual([]);
  });

  it("默认输出路由：info 到 stdout，error 到 stderr", () => {
    const errWrite = vi.spyOn(process.stderr, "write");
    const outWrite = vi.spyOn(process.stdout, "write");
    spies.push(errWrite, outWrite);
    errWrite.mockImplementation(() => true);
    outWrite.mockImplementation(() => true);

    const logger = new Logger();
    logger.info("hi");
    logger.error("boom");

    expect(outWrite).toHaveBeenCalledWith(expect.stringContaining("hi"));
    expect(errWrite).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("timestamp 开启时带时间戳前缀", () => {
    const { writes, write } = capture();
    const logger = new Logger({ timestamp: true, write });
    logger.info("t");
    expect(writes[0]?.message.startsWith("[")).toBe(true);
  });

  it("LOG_LEVELS 定义四个级别", () => {
    expect(LOG_LEVELS).toEqual(["debug", "info", "warn", "error"]);
  });
});
