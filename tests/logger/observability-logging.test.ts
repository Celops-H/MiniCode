import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Logger } from "../../src/logger/index.js";
import type { LogLevel } from "../../src/logger/index.js";
import { attachHookLogging, hookHandlerErrorText } from "../../src/logger/event-logging.js";
import { HookBus } from "../../src/hooks/index.js";
import type { HookEvent } from "../../src/hooks/index.js";

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "minicode-log-"));
}

/** 文件日志 Logger + 控制台 write 侦听（断言不落控制台） */
function fileLogger(logPath: string, level: LogLevel = "info", maxBytes?: number): { logger: Logger; consoleWrites: string[] } {
  const consoleWrites: string[] = [];
  const logger = new Logger({
    level,
    write: (_level, message) => consoleWrites.push(message),
    file: { path: logPath, ...(maxBytes !== undefined ? { maxBytes } : {}) },
  });
  return { logger, consoleWrites };
}

async function readLines(file: string): Promise<string[]> {
  const content = await readFile(file, "utf8");
  return content.split("\n").filter((l) => l.trim());
}

describe("Logger 文件输出", () => {
  it("写文件恒带时间戳、不走控制台 write；级别过滤对文件同样生效", async () => {
    const dir = await tmpDir();
    try {
      const logPath = path.join(dir, "minicode.log");
      const { logger, consoleWrites } = fileLogger(logPath, "info");
      logger.debug("调试不落");
      logger.info("信息落盘");
      logger.warn("警告落盘");
      const lines = await readLines(logPath);

      expect(lines).toHaveLength(2); // debug 被过滤
      expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T/); // 文件行恒带时间戳
      expect(lines[0]).toContain("INFO");
      expect(lines[0]).toContain("信息落盘");
      expect(lines[1]).toContain("WARN");
      expect(consoleWrites).toEqual([]); // 文件模式不走控制台
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("单文件超限轮转：当前文件改名 .old，新文件继续追加（只保留一份 .old）", async () => {
    const dir = await tmpDir();
    try {
      const logPath = path.join(dir, "logs", "minicode.log");
      const { logger } = fileLogger(logPath, "info", 180);
      // 每行约 63 字节：前两行 126 ≤ 180 累积，第三行写不下 → 轮转
      logger.warn("第一行超限内容AAAAAAAA");
      logger.warn("第二行超限内容BBBBBBBB");
      logger.warn("第三行超限内容CCCCCCCC");

      expect(existsSync(`${logPath}.old`)).toBe(true);
      const oldLines = await readFile(`${logPath}.old`, "utf8");
      expect(oldLines).toContain("第一行");
      expect(oldLines).toContain("第二行");
      const current = await readLines(logPath);
      expect(current.some((l) => l.includes("第三行"))).toBe(true);
      // 第四行放得下不再轮转；.old 仍只有一份且内容不变
      logger.warn("第四行正常追加DDDDDDDD");
      const oldLines2 = await readFile(`${logPath}.old`, "utf8");
      expect(oldLines2).toContain("第二行");
      expect(oldLines2).not.toContain("第三行");
      const current2 = await readLines(logPath);
      expect(current2.some((l) => l.includes("第四行"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("写失败静默降级：路径不可写（指向目录）时日志丢弃但不抛错（观测不反噬业务）", async () => {
    const dir = await tmpDir();
    try {
      // 日志路径指向一个已存在的目录：appendFileSync 必失败
      const { logger, consoleWrites } = fileLogger(dir, "info");
      expect(() => {
        logger.info("写入必失败");
        logger.error("错误也静默");
      }).not.toThrow();
      expect(consoleWrites).toEqual([]); // 失败不回落控制台
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("控制台模式不受文件选项影响（未配置 file 时行为不变）", async () => {
    const writes: string[] = [];
    const logger = new Logger({ write: (_l, m) => writes.push(m) });
    logger.info("控制台照常");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("控制台照常");
  });
});

describe("attachHookLogging：事件流水埋点", () => {
  /** 捕获 write 的文件模式 Logger（直接断言写入行） */
  function captureLogger(): { logger: Logger; lines: Array<{ level: LogLevel; message: string }> } {
    const lines: Array<{ level: LogLevel; message: string }> = [];
    const logger = new Logger({
      level: "debug",
      write: (level, message) => lines.push({ level, message }),
    });
    return { logger, lines };
  }

  it("模型请求：info 记耗时与结果，usage 记 debug 级（token 明细不进 info）", () => {
    const bus = new HookBus();
    const { logger, lines } = captureLogger();
    attachHookLogging(bus, logger);
    bus.emit({
      type: "LlmCallEnd",
      agentPath: "/root",
      model: "glm-5.3",
      durationMs: 3210,
      usage: { inputTokens: 12000, outputTokens: 800, cacheReadTokens: 9500, cacheWriteTokens: 500 },
      stopReason: "tool_use",
    });
    const infos = lines.filter((l) => l.level === "info").map((l) => l.message);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain("模型请求 glm-5.3");
    expect(infos[0]).toContain("耗时 3210ms");
    expect(infos[0]).toContain("停因 tool_use");
    const debugs = lines.filter((l) => l.level === "debug").map((l) => l.message);
    expect(debugs[0]).toContain("缓存读 9500");
    expect(infos[0]).not.toContain("9500"); // token 明细不进 info
  });

  it("失败请求与模型切换、压缩、权限拒绝各记一条 info", () => {
    const bus = new HookBus();
    const { logger, lines } = captureLogger();
    attachHookLogging(bus, logger);
    bus.emit({ type: "LlmCallEnd", agentPath: "/root", model: "m1", durationMs: 12, error: "429 限流" });
    bus.emit({ type: "ModelFallback", agentPath: "/root", from: "m1", to: "m2", reason: "error" });
    bus.emit({
      type: "Compact",
      agentPath: "/root",
      trigger: "auto",
      tokensBefore: 90000,
      tokensAfter: 30000,
      messagesBefore: 30,
      messagesAfter: 4,
      durationMs: 800,
      ok: true,
    });
    bus.emit({ type: "PermissionDecision", agentPath: "/root", toolCallId: "c1", toolName: "bash", decision: "deny", source: "user" });
    bus.emit({ type: "PermissionDecision", agentPath: "/root", toolCallId: "c2", toolName: "read", decision: "allow", source: "rule" });

    const messages = lines.filter((l) => l.level === "info").map((l) => l.message);
    expect(messages[0]).toContain("失败（429 限流）");
    expect(messages[1]).toContain("模型切换：m1 → m2（调用失败）");
    expect(messages[2]).toContain("压缩（撞线自动）完成：消息 30 → 4 条");
    expect(messages[3]).toContain("权限拒绝 bash（来源 用户）");
    expect(messages).toHaveLength(4); // allow 不记日志
  });

  it("压缩失败带原因；工具失败 info 记错误、参数全文只进 debug", () => {
    const bus = new HookBus();
    const { logger, lines } = captureLogger();
    attachHookLogging(bus, logger);
    bus.emit({
      type: "Compact",
      agentPath: "/root",
      trigger: "manual",
      tokensBefore: 100,
      tokensAfter: 100,
      messagesBefore: 2,
      messagesAfter: 2,
      durationMs: 5,
      ok: false,
      error: "摘要结果为空",
    });
    bus.emit({
      type: "PostToolUseFailure",
      agentPath: "/root",
      toolCallId: "c1",
      toolName: "bash",
      input: { command: "rm -rf 产物目录", recursive: true },
      error: "命令执行失败：目录不存在",
      durationMs: 10,
    });

    const infos = lines.filter((l) => l.level === "info").map((l) => l.message);
    expect(infos[0]).toContain("压缩失败（摘要结果为空）");
    expect(infos[1]).toContain("工具失败 bash：命令执行失败：目录不存在");
    expect(infos.join("\n")).not.toContain("rm -rf"); // 参数全文不进 info（隐私口径）
    const debugs = lines.filter((l) => l.level === "debug").map((l) => l.message);
    expect(debugs[0]).toContain("rm -rf 产物目录"); // debug 级才展开
  });

  it("返回的取消函数退订全部事件", () => {
    const bus = new HookBus();
    const { logger, lines } = captureLogger();
    const off = attachHookLogging(bus, logger);
    off();
    bus.emit({ type: "ModelFallback", agentPath: "/root", from: "m1", to: "m2", reason: "cooldown" });
    expect(lines).toEqual([]);
  });
});

describe("HookBus.onHandlerError：处理器异常可见", () => {
  it("单个 handler 抛错时回调收到错误与事件，同事件其余 handler 与业务不受影响", async () => {
    const errors: Array<{ error: unknown; event: HookEvent }> = [];
    const bus = new HookBus({ onHandlerError: (error, event) => errors.push({ error, event }) });
    const after = vi.fn();
    bus.on("Stop", () => {
      throw new Error("观测层故障");
    });
    bus.on("Stop", after);
    // 抛错的 handler 不产出结果位，后序 handler 的结果照常收集
    await expect(bus.emit({ type: "Stop", agentPath: "/root" })).resolves.toEqual([undefined]);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBeInstanceOf(Error);
    expect(errors[0]!.event).toMatchObject({ type: "Stop" });
    expect(after).toHaveBeenCalledTimes(1); // 后序 handler 正常执行
  });

  it("无回调时行为与旧版一致（静默吞掉不抛出）", async () => {
    const bus = new HookBus();
    bus.on("Stop", () => {
      throw new Error("boom");
    });
    await expect(bus.emit({ type: "Stop", agentPath: "/root" })).resolves.toEqual([]);
  });

  it("hookHandlerErrorText 组装可读文案", () => {
    const text = hookHandlerErrorText(new Error("坏了"), { type: "Stop", agentPath: "/root" });
    expect(text).toContain("hook 处理器异常（Stop）");
    expect(text).toContain("坏了");
  });
});
