/**
 * 层 1：状态行用量与工具耗时（可观测性 B4）——纯函数与恢复重建。
 * 归一口径、水位刷新、耗时回填、轨迹降级重建（OBSERVABILITY §5.1）。
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  accumulateUsage,
  formatTokens,
  initState,
  reduceHook,
  resetToNewState,
  type TuiState,
} from "../../src/tui/state.js";
import { rebuildUsageFromTrace, usageFromMessages } from "../../src/tui/usage.js";
import type { Message } from "../../src/core/index.js";

describe("accumulateUsage：归一口径（OBSERVABILITY §5.1）", () => {
  it("anthropic 协议：输入 = input + 缓存读 + 缓存写（input_tokens 不含缓存段）", () => {
    const sum = accumulateUsage(undefined, {
      modelApi: "anthropic-messages",
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 9000, cacheWriteTokens: 500 },
    });
    expect(sum).toEqual({ inputTokens: 10500, outputTokens: 200, cacheReadTokens: 9000 });
  });

  it("openai 协议：输入 = prompt 全量（cached ⊆ prompt，不重复相加）", () => {
    const sum = accumulateUsage(undefined, {
      modelApi: "openai-chat-completions",
      usage: { inputTokens: 10000, outputTokens: 200, cacheReadTokens: 9000 },
    });
    expect(sum).toEqual({ inputTokens: 10000, outputTokens: 200, cacheReadTokens: 9000 });
  });

  it("协议未知按保守口径取 input 原值（防未知 openai 类协议把 cached 重复计入）；无 usage 累计不变；多次调用累加", () => {
    const first = accumulateUsage(undefined, { usage: { inputTokens: 100, outputTokens: 10 } });
    expect(first).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 });
    const none = accumulateUsage(first, {});
    expect(none).toEqual(first);
    const second = accumulateUsage(first, {
      modelApi: "anthropic-messages",
      usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 30 },
    });
    expect(second).toEqual({ inputTokens: 180, outputTokens: 15, cacheReadTokens: 30 });
  });
});

describe("formatTokens：人性化计数", () => {
  it("不足 1k 原样、k 与 M 各一位小数、整值去掉 .0", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1230)).toBe("1.2k");
    expect(formatTokens(12000)).toBe("12k");
    expect(formatTokens(45600)).toBe("45.6k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(2_000_000)).toBe("2M");
  });
});

describe("reduceHook：用量累计与水位刷新", () => {
  function base(): TuiState {
    return initState([]);
  }

  it("LlmCallEnd 按注入的协议归一累计", () => {
    let s = reduceHook(base(), {
      type: "LlmCallEnd",
      agentPath: "/root",
      model: "m",
      durationMs: 10,
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 },
      modelApi: "anthropic-messages",
    });
    expect(s.usage).toEqual({ inputTokens: 1500, outputTokens: 100, cacheReadTokens: 500 });
    // 无 usage 的事件不改变累计
    s = reduceHook(s, { type: "LlmCallEnd", agentPath: "/root", model: "m", durationMs: 5 });
    expect(s.usage).toEqual({ inputTokens: 1500, outputTokens: 100, cacheReadTokens: 500 });
  });

  it("MessageAppended / Compact 注入的 contextTokens 刷新水位，未注入不动", () => {
    let s = reduceHook(base(), {
      type: "MessageAppended",
      agentPath: "/root",
      message: { role: "user", id: "m1", content: "hi" },
      contextTokens: 1234,
    });
    expect(s.contextTokens).toBe(1234);
    // 未注入（子 agent 事件不进该分支；直调防御）保持原值
    s = reduceHook(s, { type: "MessageAppended", agentPath: "/root/task_1", message: { role: "user", id: "m2", content: "x" } });
    expect(s.contextTokens).toBe(1234);
    s = reduceHook(s, {
      type: "Compact",
      agentPath: "/root",
      trigger: "manual",
      tokensBefore: 1234,
      tokensAfter: 100,
      messagesBefore: 10,
      messagesAfter: 2,
      durationMs: 5,
      ok: true,
      contextTokens: 100,
    });
    expect(s.contextTokens).toBe(100);
  });

  it("PostToolUse / PostToolUseFailure 把耗时写上工具卡片；执行前被拒（无 durationMs）不覆盖", async () => {
    const messages: Message[] = [
      {
        role: "assistant",
        id: "a1",
        timestamp: "t",
        content: [{ type: "tool_call", id: "c1", name: "bash", input: {} }],
      },
    ];
    let s = initState(messages);
    s = reduceHook(s, {
      type: "PostToolUse",
      agentPath: "/root",
      toolCallId: "c1",
      toolName: "bash",
      input: {},
      output: "ok",
      isError: false,
      durationMs: 1200,
    });
    const card = s.blocks.find((b) => b.kind === "tool");
    expect(card && card.kind === "tool" ? card.durationMs : undefined).toBe(1200);

    // 执行前被拒的失败（无 durationMs 字段）不覆盖已有耗时
    s = reduceHook(s, { type: "PostToolUseFailure", agentPath: "/root", toolCallId: "c1", toolName: "bash", input: {}, error: "x" });
    const card2 = s.blocks.find((b) => b.kind === "tool");
    expect(card2 && card2.kind === "tool" ? card2.durationMs : undefined).toBe(1200);
  });

  it("/clear（resetToNewState）清水位（防清空后仍显示高水位警示），usage 保留真实消耗", () => {
    let s: TuiState = reduceHook(initState([]), {
      type: "MessageAppended",
      agentPath: "/root",
      message: { role: "user", id: "m1", content: "hi" },
      contextTokens: 95000,
    });
    s = reduceHook(s, {
      type: "LlmCallEnd",
      agentPath: "/root",
      model: "m",
      durationMs: 10,
      usage: { inputTokens: 5000, outputTokens: 300 },
    });
    const cleared = resetToNewState(s);
    expect(cleared.contextTokens).toBeUndefined();
    expect(cleared.usage).toEqual({ inputTokens: 5000, outputTokens: 300, cacheReadTokens: 0 });
  });
});

describe("initState：工具耗时恢复回填", () => {
  const messages: Message[] = [
    {
      role: "assistant",
      id: "a1",
      timestamp: "t",
      content: [
        { type: "tool_call", id: "c1", name: "read", input: {} },
        { type: "tool_call", id: "c2", name: "bash", input: {} },
      ],
    },
  ];

  it("轨迹回填表按 toolCallId 命中卡片；无条目（被中断/被拒）不显示", () => {
    const state = initState(messages, "", "", new Map([["c1", 800]]));
    const cards = state.blocks.filter((b) => b.kind === "tool");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ id: "c1", durationMs: 800 });
    expect(cards[1]).toMatchObject({ id: "c2", durationMs: undefined });
  });

  it("不传回填表时卡片不带耗时", () => {
    const state = initState(messages);
    for (const b of state.blocks) {
      if (b.kind === "tool") expect(b.durationMs).toBeUndefined();
    }
  });
});

describe("恢复重建降级（OBSERVABILITY §5.1）", () => {
  async function tmpDir(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "minicode-usage-"));
  }

  it("轨迹存在：LlmCallEnd 按协议归一累计、PostToolUse 提取耗时表", async () => {
    const dir = await tmpDir();
    try {
      const tracesDir = path.join(dir, "traces");
      await mkdir(tracesDir, { recursive: true });
      const file = path.join(tracesDir, "s1.jsonl");
      const header = JSON.stringify({ format: "minicode-trace", formatVersion: 1, sessionId: "s1", cwd: "x", minicodeVersion: "0.0.1", startedAt: "t" });
      const events = [
        // 主 agent anthropic 调用：输入 = 1000 + 9000 + 500
        JSON.stringify({ kind: "event", event: "LlmCallEnd", agentPath: "/root", timestamp: "t", data: { model: "glm", durationMs: 10, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 500 } } }),
        // 子 agent openai 调用：prompt 全量
        JSON.stringify({ kind: "event", event: "LlmCallEnd", agentPath: "/root/task_1", timestamp: "t", data: { model: "ds", durationMs: 10, usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 100 } } }),
        JSON.stringify({ kind: "event", event: "PostToolUse", agentPath: "/root", timestamp: "t", data: { toolCallId: "c1", toolName: "read", durationMs: 1500 } }),
        // 被中断的调用无 durationMs：不进耗时表
        JSON.stringify({ kind: "event", event: "PostToolUseFailure", agentPath: "/root", timestamp: "t", data: { toolCallId: "c2", toolName: "bash", error: "中断" } }),
        // 执行中失败的调用带执行窗口耗时（B1）：同样回填
        JSON.stringify({ kind: "event", event: "PostToolUseFailure", agentPath: "/root", timestamp: "t", data: { toolCallId: "c3", toolName: "bash", error: "超时", durationMs: 700 } }),
      ].join("\n");
      await writeFile(file, `${header}\n${events}\n`, "utf8");

      const rebuilt = await rebuildUsageFromTrace(file, (id) => (id === "glm" ? "anthropic-messages" : "openai-chat-completions"));
      expect(rebuilt.usage).toEqual({ inputTokens: 10800, outputTokens: 120, cacheReadTokens: 9100 });
      expect(rebuilt.toolDurations.get("c1")).toBe(1500);
      expect(rebuilt.toolDurations.get("c3")).toBe(700);
      expect(rebuilt.toolDurations.has("c2")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("轨迹不存在：返回无数据（调用方回落会话 meta.usage）", async () => {
    const dir = await tmpDir();
    try {
      const rebuilt = await rebuildUsageFromTrace(path.join(dir, "nope.jsonl"), () => undefined);
      expect(rebuilt.usage).toBeUndefined();
      expect(rebuilt.toolDurations.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("回落口径：会话 assistant meta.usage 累计（无缓存段），无任何用量返回 undefined", () => {
    const messages: Message[] = [
      { role: "user", id: "u1", content: "hi" },
      { role: "assistant", id: "a1", content: [], meta: { model: "m", usage: { inputTokens: 500, outputTokens: 60 } }, timestamp: "t" },
      { role: "assistant", id: "a2", content: [], meta: { model: "m", usage: { inputTokens: 700, outputTokens: 40 } }, timestamp: "t" },
      { role: "assistant", id: "a3", content: [], timestamp: "t" },
    ];
    expect(usageFromMessages(messages)).toEqual({ inputTokens: 1200, outputTokens: 100, cacheReadTokens: 0 });
    expect(usageFromMessages([{ role: "user", id: "u1", content: "hi" }])).toBeUndefined();
  });
});
