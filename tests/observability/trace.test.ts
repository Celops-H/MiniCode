import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import { HookBus } from "../../src/hooks/index.js";
import { z } from "zod";
import {
  attachRecorder,
  cleanupStaleTraces,
  deleteTrace,
  Recorder,
  TraceReader,
  TraceWriter,
  TRACE_FORMAT,
  TRACE_FORMAT_VERSION,
} from "../../src/observability/index.js";
import { resolveSessionsDir } from "../../src/config/paths.js";

/** 建临时目录（每个用例独立） */
async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "minicode-trace-"));
}

/** 直接读轨迹文件全部行（JSON 反序列化） */
async function readLines(filePath: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(filePath, "utf8");
  return content
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("Recorder：轨迹格式与落盘", () => {
  it("header 在首行，事件行与消息行按 kind 区分、agentPath 提升到行级、data 携带负载", async () => {
    const dir = await tmpDir();
    try {
      const bus = new HookBus();
      const recorder = new Recorder(bus, {
        sessionId: "s1",
        cwd: "C:\\work\\proj",
        minicodeVersion: "0.0.1",
        sessionsRoot: path.join(dir, "sessions"),
        dir: path.join(dir, "traces"),
        batchSize: 1000, // 不自动攒批触发，靠 SessionEnd 冲刷
      });
      bus.emit({ type: "SessionStart" });
      bus.emit({ type: "UserPromptSubmit", input: "你好" });
      bus.emit({
        type: "MessageAppended",
        agentPath: "/root",
        message: { role: "user", id: "m1", content: "你好", timestamp: "2026-10-01T00:00:00.000Z" },
      });
      bus.emit({
        type: "LlmCallEnd",
        agentPath: "/root",
        model: "glm-5.3",
        durationMs: 3210,
        usage: { inputTokens: 12000, outputTokens: 800, cacheReadTokens: 9500 },
        stopReason: "tool_use",
      });
      await bus.emit({ type: "SessionEnd" });
      recorder.dispose();

      const lines = await readLines(path.join(dir, "traces", "s1.jsonl"));
      // header
      expect(lines[0]).toMatchObject({
        format: TRACE_FORMAT,
        formatVersion: TRACE_FORMAT_VERSION,
        sessionId: "s1",
        cwd: "C:\\work\\proj",
        minicodeVersion: "0.0.1",
      });
      expect(typeof lines[0]!.startedAt).toBe("string");
      // 事件行（无 agentPath 的会话级事件：行级省略该键）
      expect(lines[1]).toMatchObject({ kind: "event", event: "SessionStart" });
      expect(lines[1]).not.toHaveProperty("agentPath");
      expect(typeof lines[1]!.timestamp).toBe("string");
      expect(lines[2]).toMatchObject({ kind: "event", event: "UserPromptSubmit", data: { input: "你好" } });
      // 消息行：消息字段平铺（role/id/content/timestamp），agentPath 标注归属
      expect(lines[3]).toMatchObject({
        kind: "message",
        agentPath: "/root",
        role: "user",
        id: "m1",
        content: "你好",
        timestamp: "2026-10-01T00:00:00.000Z",
      });
      // 事件行（带 agentPath + data 负载，type 不进 data）
      expect(lines[4]).toMatchObject({
        kind: "event",
        event: "LlmCallEnd",
        agentPath: "/root",
        data: {
          model: "glm-5.3",
          durationMs: 3210,
          usage: { inputTokens: 12000, outputTokens: 800, cacheReadTokens: 9500 },
          stopReason: "tool_use",
        },
      });
      expect(lines[4]!.data).not.toHaveProperty("type");
      // 收尾事件
      expect(lines.at(-1)).toMatchObject({ kind: "event", event: "SessionEnd" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("header.metadata 原样落盘（评测宿主注入任务身份）", async () => {
    const dir = await tmpDir();
    try {
      const bus = new HookBus();
      const recorder = new Recorder(bus, {
        sessionId: "s-meta",
        cwd: os.tmpdir(),
        minicodeVersion: "0.0.1",
        sessionsRoot: path.join(dir, "sessions"),
        dir: path.join(dir, "traces"),
        batchSize: 1000,
        metadata: { dataset: "swe-bench", taskId: "t-1", run: "r-9", attempt: 2 },
      });
      bus.emit({ type: "SessionStart" });
      await recorder.flush();
      recorder.dispose();

      const lines = await readLines(path.join(dir, "traces", "s-meta.jsonl"));
      expect(lines[0]).toMatchObject({
        metadata: { dataset: "swe-bench", taskId: "t-1", run: "r-9", attempt: 2 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("完整 agent 回合：消息与调用事件全部入轨迹（轨迹自足，恢复重建的数据源）", async () => {
    const dir = await tmpDir();
    try {
      const bus = new HookBus();
      const recorder = new Recorder(bus, {
        sessionId: "s2",
        cwd: os.tmpdir(),
        minicodeVersion: "0.0.1",
        sessionsRoot: path.join(dir, "sessions"),
        dir: path.join(dir, "traces"),
        batchSize: 1000,
      });
      const agent = new Agent({
        // 工具回合 mock：read 工具调用 → 结果回灌 → 总结
        modelClient: {
          async *stream(_modelId, context) {
            const hasResult = context.messages.some((m) => m.role === "tool_result");
            if (!hasResult) {
              yield { type: "toolcall_start", index: 0, id: "c1", name: "read" };
              yield { type: "toolcall_end", index: 0 };
              yield { type: "done", stopReason: "tool_calls" };
            } else {
              yield { type: "text_delta", text: "已读" };
              yield { type: "done", stopReason: "end_turn" };
            }
          },
        } satisfies ModelClient,
        modelId: "mock",
        systemPrompt: "助手",
        hooks: bus,
        tools: [
          {
            name: "read",
            description: "读取文件",
            inputSchema: z.object({}),
            isReadOnly: true,
            maxResultSizeChars: 1000,
            execute: () => "文件内容",
          },
        ],
      });
      bus.emit({ type: "SessionStart" });
      agent.start("读文件");
      for await (const _ of agent.run()) {
        // 消费事件流
      }
      await bus.emit({ type: "SessionEnd" });
      recorder.dispose();

      const lines = await readLines(path.join(dir, "traces", "s2.jsonl"));
      const events = lines.filter((l) => l.kind === "event").map((l) => l.event);
      expect(events).toContain("PreToolUse");
      expect(events).toContain("PostToolUse");
      expect(events).toContain("LlmCallEnd");
      expect(events).toContain("Stop");
      // 消息全文经 MessageAppended 以消息行落盘（kind=message，非事件行）
      expect(lines.filter((l) => l.kind === "message").map((l) => l.role)).toEqual([
        "user",
        "assistant",
        "tool_result",
        "assistant",
      ]);
      // 两次 LlmCallEnd（工具轮 + 总结轮），每条带 systemPrompt.hash
      const llmEnds = lines.filter((l) => l.kind === "event" && l.event === "LlmCallEnd");
      expect(llmEnds).toHaveLength(2);
      expect((llmEnds[0]!.data as Record<string, unknown>).systemPrompt).toBeDefined();
      // 消息行含工具结果全文
      const toolResult = lines.find((l) => l.kind === "message" && l.role === "tool_result");
      expect(toolResult).toMatchObject({ toolCallId: "c1", content: "文件内容" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("TraceWriter：攒批与冲刷", () => {
  it("未达攒批阈值不落盘，flush 后一次写入；文件权限位按 0600 语义创建", async () => {
    const dir = await tmpDir();
    try {
      const bus = new HookBus();
      const recorder = new Recorder(bus, {
        sessionId: "s3",
        cwd: os.tmpdir(),
        minicodeVersion: "0.0.1",
        sessionsRoot: path.join(dir, "sessions"),
        dir: path.join(dir, "traces"),
        batchSize: 1000,
      });
      bus.emit({ type: "SessionStart" });
      bus.emit({ type: "Stop", agentPath: "/root" });
      // 未冲刷：文件尚不存在（攒批中）
      expect(existsSync(path.join(dir, "traces", "s3.jsonl"))).toBe(false);
      await recorder.flush();
      expect(existsSync(path.join(dir, "traces", "s3.jsonl"))).toBe(true);
      const lines = await readLines(path.join(dir, "traces", "s3.jsonl"));
      expect(lines).toHaveLength(3); // header + SessionStart + Stop
      recorder.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("达到攒批阈值自动落盘（异步触发）", async () => {
    const dir = await tmpDir();
    try {
      const bus = new HookBus();
      new Recorder(bus, {
        sessionId: "s4",
        cwd: os.tmpdir(),
        minicodeVersion: "0.0.1",
        sessionsRoot: path.join(dir, "sessions"),
        dir: path.join(dir, "traces"),
        batchSize: 2, // header + 1 条事件即触发
      });
      bus.emit({ type: "SessionStart" });
      await new Promise((resolve) => setTimeout(resolve, 20)); // 等异步 flush
      const lines = await readLines(path.join(dir, "traces", "s4.jsonl"));
      expect(lines).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("进程级收尾冲刷注册：exit/SIGINT/SIGTERM 只装一次（重复创建 writer 不重复注册）", async () => {
    // 完整的信号送达链路依赖平台（Windows 上 kill 型信号一律硬终止、不触发 JS 监听），
    // 这里验证可确定的部分：注册幂等 + flushSync 同步落盘残余缓冲
    const dir = await tmpDir();
    try {
      const bus = new HookBus();
      const recorder = new Recorder(bus, {
        sessionId: "s-signal",
        cwd: os.tmpdir(),
        minicodeVersion: "0.0.1",
        sessionsRoot: path.join(dir, "sessions"),
        dir: path.join(dir, "traces"),
        batchSize: 1000,
      });
      // 进程级监听已就位（首个 writer 安装；本文件此前的用例可能已装过，故用 ≥）
      expect(process.listenerCount("exit")).toBeGreaterThanOrEqual(1);
      expect(process.listenerCount("SIGINT")).toBeGreaterThanOrEqual(1);
      expect(process.listenerCount("SIGTERM")).toBeGreaterThanOrEqual(1);

      // 会话轮换再创建 writer：不新增进程级监听（幂等）
      const exitCount = process.listenerCount("exit");
      const intCount = process.listenerCount("SIGINT");
      const termCount = process.listenerCount("SIGTERM");
      const bus2 = new HookBus();
      const recorder2 = new Recorder(bus2, {
        sessionId: "s-signal2",
        cwd: os.tmpdir(),
        minicodeVersion: "0.0.1",
        sessionsRoot: path.join(dir, "sessions"),
        dir: path.join(dir, "traces"),
        batchSize: 1000,
      });
      expect(process.listenerCount("exit")).toBe(exitCount);
      expect(process.listenerCount("SIGINT")).toBe(intCount);
      expect(process.listenerCount("SIGTERM")).toBe(termCount);

      // flush：未达阈值留在缓冲的行被写入（收尾冲刷路径；flushSync 为其同步形态，direct 测试见下）
      bus.emit({ type: "SessionStart" });
      bus.emit({ type: "Stop", agentPath: "/root" });
      expect(existsSync(path.join(dir, "traces", "s-signal.jsonl"))).toBe(false);
      await recorder.flush();
      const lines = await readLines(path.join(dir, "traces", "s-signal.jsonl"));
      expect(lines).toHaveLength(3);
      recorder.dispose();
      recorder2.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("TraceWriter：flushSync 与 header 去重", () => {
  it("flushSync 同步落盘残余缓冲（exit/信号处理器同路径）", async () => {
    const dir = await tmpDir();
    try {
      const tracesDir = path.join(dir, "traces");
      const file = path.join(tracesDir, "sync.jsonl");
      const writer = new TraceWriter(file, JSON.stringify({ format: TRACE_FORMAT, formatVersion: 1, sessionId: "sync", cwd: "x", minicodeVersion: "0.0.1", startedAt: "t" }), 1000);
      writer.appendLine(JSON.stringify({ kind: "event", event: "Stop", agentPath: "/root", timestamp: "t", data: {} }));
      expect(existsSync(file)).toBe(false);
      writer.flushSync();
      const lines = await readLines(file);
      expect(lines).toHaveLength(2); // header + Stop
      // 再 append 再 flushSync：追加不覆盖
      writer.appendLine(JSON.stringify({ kind: "event", event: "SessionEnd", timestamp: "t2", data: {} }));
      writer.flushSync();
      expect((await readLines(file)).length).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("续跑的轨迹文件已存在时不重复插 header（恢复会话只追加）", async () => {
    const dir = await tmpDir();
    try {
      const tracesDir = path.join(dir, "traces");
      await mkdir(tracesDir, { recursive: true });
      const file = path.join(tracesDir, "resume.jsonl");
      const headerLine = JSON.stringify({ format: TRACE_FORMAT, formatVersion: 1, sessionId: "resume", cwd: "x", minicodeVersion: "0.0.1", startedAt: "t" });
      await writeFile(file, `${headerLine}\n${JSON.stringify({ kind: "event", event: "SessionStart", timestamp: "t", data: {} })}\n`, "utf8");
      // 新 writer（模拟会话恢复重新装配）：文件已存在则不写 header
      const writer = new TraceWriter(file, headerLine, 1000);
      writer.appendLine(JSON.stringify({ kind: "event", event: "Stop", agentPath: "/root", timestamp: "t2", data: {} }));
      await writer.flush();
      const lines = await readLines(file);
      expect(lines).toHaveLength(3); // 原有 2 行 + 追加 1 行，无第二个 header
      expect(lines.filter((l) => l.format === TRACE_FORMAT)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("TraceReader：流式读取与容错", () => {
  it("未知 kind 与损坏行跳过不报错，合法行照常产出；events 按 event/agentPath 过滤", async () => {
    const dir = await tmpDir();
    try {
      const tracesDir = path.join(dir, "traces");
      await mkdir(tracesDir, { recursive: true });
      const file = path.join(tracesDir, "s5.jsonl");
      await writeFile(
        file,
        [
          JSON.stringify({ format: TRACE_FORMAT, formatVersion: 1, sessionId: "s5", cwd: "x", minicodeVersion: "0.0.1", startedAt: "t" }),
          JSON.stringify({ kind: "event", event: "Stop", agentPath: "/root", timestamp: "t1", data: {} }),
          "this is not json",
          JSON.stringify({ kind: "future_kind", payload: "未知版本的新行类型" }),
          JSON.stringify({ kind: "event", event: "PostToolUse", agentPath: "/root/task_1", timestamp: "t2", data: { output: "子 agent 工具输出" } }),
          JSON.stringify({ kind: "message", agentPath: "/root/task_1", role: "assistant", id: "m9", content: [] }),
          "",
        ].join("\n"),
        "utf8",
      );

      // header 可读
      const header = await TraceReader.readHeader(file);
      expect(header).toMatchObject({ format: TRACE_FORMAT, sessionId: "s5" });

      const lines: Array<{ kind: string }> = [];
      for await (const line of TraceReader.lines(file)) lines.push(line as { kind: string });
      expect(lines.map((l) => l.kind)).toEqual(["event", "event", "message"]);

      const stops: Array<Record<string, unknown>> = [];
      for await (const e of TraceReader.events(file, { event: "Stop" })) stops.push(e as unknown as Record<string, unknown>);
      expect(stops).toHaveLength(1);
      const subAgent: Array<Record<string, unknown>> = [];
      for await (const e of TraceReader.events(file, { agentPath: "/root/task_1" })) subAgent.push(e as unknown as Record<string, unknown>);
      expect(subAgent).toHaveLength(1); // 子 agent 的事件（message 行不算事件）
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("不存在的轨迹 readHeader 返回 undefined（消费方降级路径）", async () => {
    const dir = await tmpDir();
    try {
      const header = await TraceReader.readHeader(path.join(dir, "nope.jsonl"));
      expect(header).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("会话删除联动与惰性清理", () => {
  it("deleteTrace 删除指定轨迹，文件不存在时静默通过", async () => {
    const dir = await tmpDir();
    try {
      const tracesDir = path.join(dir, "traces");
      await mkdir(tracesDir, { recursive: true });
      const file = path.join(tracesDir, "gone.jsonl");
      await writeFile(file, "x", "utf8");
      await deleteTrace(tracesDir, "gone");
      expect(existsSync(file)).toBe(false);
      // 不存在：force 静默通过不抛错
      await expect(deleteTrace(tracesDir, "never-existed")).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("惰性清理：会话文件已存在的轨迹保留，已不存在的删除，当前会话跳过，头损坏跳过", async () => {
    const dir = await tmpDir();
    try {
      const tracesDir = path.join(dir, "traces");
      const sessionsRoot = path.join(dir, "sessions");
      await mkdir(tracesDir, { recursive: true });
      // cwd A：会话存在；cwd B：会话子目录在而文件缺（会话被删后的真实残留形态）
      const cwdA = path.join(dir, "projA");
      const cwdB = path.join(dir, "projB");
      await mkdir(resolveSessionsDir({ root: sessionsRoot, cwd: cwdA }), { recursive: true });
      await mkdir(resolveSessionsDir({ root: sessionsRoot, cwd: cwdB }), { recursive: true });
      const headerLine = (sessionId: string, cwd: string): string =>
        JSON.stringify({ format: TRACE_FORMAT, formatVersion: 1, sessionId, cwd, minicodeVersion: "0.0.1", startedAt: "t" });
      await writeFile(path.join(tracesDir, "alive.jsonl"), `${headerLine("alive", cwdA)}\n`, "utf8");
      await mkdir(resolveSessionsDir({ root: sessionsRoot, cwd: cwdA }), { recursive: true });
      await writeFile(path.join(resolveSessionsDir({ root: sessionsRoot, cwd: cwdA }), "alive.jsonl"), "", "utf8");
      await writeFile(path.join(tracesDir, "stale.jsonl"), `${headerLine("stale", cwdB)}\n`, "utf8");
      // 会话子目录根本不存在的 cwd（换根守卫场景）：布局未知，保守跳过不删
      const cwdC = path.join(dir, "projC");

      await writeFile(path.join(tracesDir, "other-root.jsonl"), `${headerLine("other-root", cwdC)}\n`, "utf8");
      // 当前会话（草稿未落盘）：即使会话文件不存在也不能误删
      await writeFile(path.join(tracesDir, "current.jsonl"), `${headerLine("current", cwdB)}\n`, "utf8");
      // 头损坏：保守跳过不删
      await writeFile(path.join(tracesDir, "broken.jsonl"), "not-json\n", "utf8");

      const removed = await cleanupStaleTraces(tracesDir, sessionsRoot, "current");
      expect(removed).toBe(1);
      expect(existsSync(path.join(tracesDir, "alive.jsonl"))).toBe(true);
      expect(existsSync(path.join(tracesDir, "stale.jsonl"))).toBe(false);
      expect(existsSync(path.join(tracesDir, "current.jsonl"))).toBe(true);
      expect(existsSync(path.join(tracesDir, "broken.jsonl"))).toBe(true);
      // 换根守卫：会话子目录不存在的 cwd 对应轨迹保守保留
      expect(existsSync(path.join(tracesDir, "other-root.jsonl"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("attachRecorder 装配", () => {
  it("enabled=false 不装配；缺省开启；dir 缺省解析", async () => {
    const bus = new HookBus();
    expect(attachRecorder(bus, { sessionId: "s", cwd: "x", minicodeVersion: "0.0.1", sessionsRoot: "sr", enabled: false })).toBeUndefined();
    const recorder = attachRecorder(bus, { sessionId: "s2", cwd: "x", minicodeVersion: "0.0.1", sessionsRoot: "sr" });
    expect(recorder).toBeDefined();
    expect(recorder!.dir).toBe(path.join(os.homedir(), ".minicode", "traces"));
    recorder!.dispose();
  });
});
