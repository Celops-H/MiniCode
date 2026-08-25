import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, AgentPath } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import { interact } from "../../src/cli/interact.js";
import { buildModelClient } from "../../src/cli/models.js";
import { buildCompactConfig, buildHookBus, createSessionAgent } from "../../src/cli/app.js";
import { configSchema, loadConfig } from "../../src/config/index.js";
import { HookBus } from "../../src/hooks/index.js";
import { SessionStore } from "../../src/storage/index.js";
import type { Tool } from "../../src/tools/index.js";
import type { Models } from "../../src/llm/index.js";

/** 用给定 hooks 配置解析配置（写临时项目配置文件，绕开用户级配置） */
async function loadConfigWith(hooks: Record<string, string[]>): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cfg-"));
  try {
    writeFileSync(path.join(dir, ".minicode.json"), JSON.stringify({ hooks }));
    return await loadConfig({ paths: { globalConfigFile: path.join(dir, "none.json"), projectConfigFile: path.join(dir, ".minicode.json") } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mockTextClient(text: string): ModelClient {
  return {
    async *stream() {
      yield { type: "text_delta", text };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

describe("CLI 模型组装", () => {
  it("buildModelClient 注册默认 DeepSeek 模型", () => {
    const models = buildModelClient();
    expect(models.resolve("deepseek-chat")).toBeDefined();
  });

  it("可覆盖模型 id", () => {
    const models = buildModelClient(undefined, "qwen-plus");
    expect(models.resolve("qwen-plus")).toBeDefined();
  });
});

describe("CLI 多 Agent 组装", () => {
  it("关闭 agents：单 agent 会话，协作工具不可见", async () => {
    const toolsSeen: string[][] = [];
    const client: ModelClient = {
      async *stream(_modelId, context) {
        toolsSeen.push(context.tools.map((t) => t.name));
        yield { type: "text_delta", text: "ok" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const readTool: Tool = {
      name: "read",
      description: "读取文件",
      inputSchema: z.object({ path: z.string() }),
      isReadOnly: true,
      requiresUserInteraction: false,
      maxResultSizeChars: 100,
      execute: () => "内容",
    };
    const { agent, team } = createSessionAgent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      tools: [readTool],
      agents: false,
    });
    expect(team).toBeUndefined();
    agent.start("hi");
    for await (const _ of agent.run()) {
      // 消费
    }
    expect(toolsSeen[0]).toContain("read");
    expect(toolsSeen[0]).not.toContain("spawn_agent");
  });

  it("开启 agents：建 Team 注册 root、系统提示补协调者角色、协作工具可见", async () => {
    let toolsSeen: string[] = [];
    let systemPrompt = "";
    const client: ModelClient = {
      async *stream(_modelId, context) {
        toolsSeen = context.tools.map((t) => t.name);
        systemPrompt = context.systemPrompt;
        yield { type: "text_delta", text: "ok" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const { agent, team } = createSessionAgent({
      modelClient: client,
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
      agents: true,
    });
    expect(team).toBeDefined();
    expect(team!.resolveAgent(AgentPath.root())?.agent).toBe(agent);
    agent.start("hi");
    for await (const _ of agent.run()) {
      // 消费
    }
    expect(toolsSeen).toContain("spawn_agent");
    expect(toolsSeen).toContain("wait_agent");
    expect(systemPrompt).toContain("团队协调者");
  });
});

describe("CLI Hook 接入", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("interact 每次输入后触发 UserPromptSubmit（宿主职责，DESIGN 13.3）", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    const agent = new Agent({
      modelClient: mockTextClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
    });
    const seen: string[] = [];
    const hooks = new HookBus();
    hooks.on("UserPromptSubmit", (event) => {
      seen.push(event.input);
    });

    async function* inputs(): AsyncIterable<string> {
      yield "第一问";
      yield "第二问";
      yield "/exit";
    }
    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: () => {},
      hooks,
    });
    expect(seen).toEqual(["第一问", "第二问"]);
  });

  it("onEvent 回调接管流式事件渲染（此前确认：渲染归属调用方，TUI 结构化消费）", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    const agent = new Agent({
      modelClient: mockTextClient("回复内容"),
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
    });
    const events: string[] = [];
    async function* inputs(): AsyncIterable<string> {
      yield "你好";
      yield "/exit";
    }
    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: () => {},
      onEvent: (event) => {
        if (event.type === "text_delta") events.push(event.text);
      },
    });
    // 结构化事件经 onEvent 消费（write 不再承担流式渲染）
    expect(events).toEqual(["回复内容"]);
  });

  it("后台续跑活跃时输入等待其结束再开新轮（防 start 复位中断信号与落盘游标错位）", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    let releaseBackground: () => void = () => {};
    const backgroundHeld = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    let calls = 0;
    const client: ModelClient = {
      async *stream() {
        calls++;
        if (calls === 1) {
          // 后台轮：产出一段结论后挂起（模拟子 agent 完成唤醒的续跑流）
          yield { type: "text_delta", text: "后台结论" };
          await backgroundHeld;
          yield { type: "done", stopReason: "end_turn" };
        } else {
          yield { type: "text_delta", text: "用户轮回复" };
          yield { type: "done", stopReason: "end_turn" };
        }
      },
    };
    const agent = new Agent({ modelClient: client, modelId: "mock", systemPrompt: "助手", tools: [] });

    // 后台驱动 root 续跑（模拟 Team.driveAgent）：部分消费使其保持活跃
    agent.start("后台轮任务");
    const gen = agent.resume();
    const backgroundDone = (async () => {
      for await (const _ of gen) {
        // 消费全部事件（挂起在流内）
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50)); // 推进到挂起点，active=true
    expect(agent.isActive()).toBe(true);

    // 用户在后台活跃时输入：interact 应等待后台轮结束，不立刻 start（防中断信号被复位）
    async function* inputs(): AsyncIterable<string> {
      yield "用户输入";
      yield "/exit";
    }
    const interacting = interact({ agent, store, session, inputs: inputs(), write: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 后台轮还没结束：用户消息尚未入历史（等待而非 start）
    const humans = agent.getMessages().filter((m) => m.role === "user" && m.source !== "system");
    expect(humans).toHaveLength(1);
    expect(humans[0]).toMatchObject({ content: "后台轮任务" });

    // 释放后台轮：resume 收尾、active 复位，interact 随即处理用户输入
    releaseBackground();
    await backgroundDone;
    await interacting;

    // 后台轮结论与用户输入轮都完整落历史
    const messages = agent.getMessages();
    expect(messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text === "后台结论"))).toBe(true);
    expect(messages.some((m) => m.role === "user" && m.source !== "system" && m.content === "用户输入")).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text === "用户轮回复"))).toBe(true);
  });

  it("buildHookBus：config.hooks 装配成事件 → 命令映射（空配置不启用）", () => {
    expect(buildHookBus(undefined)).toBeUndefined();
    const bus = buildHookBus({ PreToolUse: ["echo {}"], SessionStart: ["echo start"] });
    expect(bus).toBeInstanceOf(HookBus);
  });
});

describe("CLI Hook 配置 schema", () => {
  it("hooks 配置部分事件即可通过解析（partialRecord），未知事件拒绝", async () => {
    const config = await loadConfigWith({ PreToolUse: ["echo {}"] });
    expect(config.hooks).toEqual({ PreToolUse: ["echo {}"] });

    await expect(loadConfigWith({ NotAnEvent: ["echo"] } as never)).rejects.toThrow();
  });
});

describe("CLI /compact 命令", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("interact /compact：强制压缩并重写落盘，后续轮次游标不重复落盘", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    // 摘要调用（消息含摘要请求）返回摘要；正常调用返回文本
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const isSummaryRequest = context.messages.some(
            (m) => typeof m.content === "string" && m.content.includes("结构化摘要"),
          );
          if (isSummaryRequest) {
            yield { type: "text_delta", text: "压缩后的摘要" };
            yield { type: "done", stopReason: "end_turn" };
            return;
          }
          yield { type: "text_delta", text: "回复" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
      compactConfig: { contextWindow: 100000, maxOutputTokens: 1000, safetyMargin: 500, keepRecentToolResults: 1 },
    });

    async function* inputs(): AsyncIterable<string> {
      yield "第一问";
      yield "/compact";
      yield "压缩后继续";
      yield "/exit";
    }
    const outputs: string[] = [];
    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: (text) => outputs.push(text),
    });

    expect(outputs.join("")).toContain("[已压缩]");
    // 标记已消费：/compact 后的正常轮次不再误报「历史已压缩」（防标记泄漏冗余重写）
    expect(outputs.join("")).not.toContain("[历史已压缩]");
    // 压缩重写落盘后：盘上是摘要 + 后续对话，旧消息被覆盖
    const loaded = await store.loadSession(session.meta.id);
    const contents = loaded.getMessages().map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    expect(contents[0]).toContain("【会话摘要】");
    expect(contents.some((c) => c === "第一问")).toBe(false); // 旧消息已重写掉
    // 压缩后继续的一轮也落盘了
    expect(contents.at(-2)).toBe("压缩后继续");
    expect(contents.at(-1)).toContain("回复");
  });

  it("interact /compact：未配置压缩时反馈未压缩", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    const agent = new Agent({
      modelClient: mockTextClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
    });

    async function* inputs(): AsyncIterable<string> {
      yield "/compact";
      yield "/exit";
    }
    const outputs: string[] = [];
    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: (text) => outputs.push(text),
    });
    expect(outputs.join("")).toContain("[未压缩]");
  });

  it("工具调用前 checkpoint：模型消息落盘后才执行工具（DESIGN 14）", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    // 工具执行时观察盘上是否已有本轮 assistant 消息（flush checkpoint 后应为真）
    let diskHasAssistantDuringTool = false;
    const readTool: Tool = {
      name: "read",
      description: "读取文件",
      inputSchema: z.object({ path: z.string() }),
      isReadOnly: true,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: async () => {
        const { readFile } = await import("node:fs/promises");
        try {
          const raw = await readFile(path.join(dir, `${session.meta.id}.jsonl`), "utf8");
          diskHasAssistantDuringTool = raw.includes('"role":"assistant"');
        } catch {
          diskHasAssistantDuringTool = false;
        }
        return "内容";
      },
    };
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "read" };
            yield { type: "toolcall_delta", index: 0, partialJson: '{"path":"a.ts"}' };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "完成" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [readTool],
      // 模拟 app 的 checkpoint 装配（DESIGN 14）：工具执行前把已产生消息落盘
      checkpoint: async (messages) => {
        const newOnes = messages.slice(session.getMessages().length);
        for (const message of newOnes) {
          await store.appendMessage(session, message);
        }
        await store.flush();
      },
    });

    async function* inputs(): AsyncIterable<string> {
      yield "读文件";
      yield "/exit";
    }
    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: () => {},
    });
    // 工具执行时本轮 assistant 消息（含工具调用）已在盘上
    expect(diskHasAssistantDuringTool).toBe(true);
  });

  it("checkpoint 多轮工具调用：盘上消息序列与内存逐条一致（去重不重复落盘）", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    const echoTool: Tool = {
      name: "echo",
      description: "回显",
      inputSchema: z.object({ text: z.string() }),
      isReadOnly: true,
      requiresUserInteraction: false,
      maxResultSizeChars: 100,
      execute: (input) => `echo:${(input as { text: string }).text}`,
    };
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const toolResults = context.messages.filter((m) => m.role === "tool_result");
          if (toolResults.length === 0) {
            // 第一轮：两个并行工具调用
            yield { type: "toolcall_start", index: 0, id: "a1", name: "echo" };
            yield { type: "toolcall_delta", index: 0, partialJson: '{"text":"A"}' };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "toolcall_start", index: 1, id: "a2", name: "echo" };
            yield { type: "toolcall_delta", index: 1, partialJson: '{"text":"B"}' };
            yield { type: "toolcall_end", index: 1 };
            yield { type: "done", stopReason: "tool_calls" };
          } else if (toolResults.length === 2) {
            yield { type: "text_delta", text: "完成" };
            yield { type: "done", stopReason: "end_turn" };
          } else {
            yield { type: "text_delta", text: "多余轮次" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [echoTool],
      checkpoint: async (messages) => {
        const newOnes = messages.slice(session.getMessages().length);
        for (const message of newOnes) {
          await store.appendMessage(session, message);
        }
        await store.flush();
      },
    });

    async function* inputs(): AsyncIterable<string> {
      yield "并行干活";
      yield "/exit";
    }
    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: () => {},
    });
    // 盘上 = 内存（不重复、顺序一致）
    const loaded = await store.loadSession(session.meta.id);
    expect(loaded.getMessages().map((m) => m.role)).toEqual(session.getMessages().map((m) => m.role));
    expect(loaded.getMessages().map((m) => m.role)).toEqual([
      "user",
      "assistant", // 含两个并行 tool_call
      "tool_result",
      "tool_result",
      "assistant",
    ]);
    // 两个工具结果都执行成功
    expect(loaded.getMessages().map((m) => (m.role === "tool_result" ? m.content : null)).filter(Boolean)).toEqual([
      "echo:A",
      "echo:B",
    ]);
  });

  it("撞线压缩后落盘同步：agent 内存为真相重写整份盘，本轮消息不丢（存量 bug 修复）", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    // 摘要调用（消息含摘要请求）返回摘要；正常调用返回文本
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const isSummaryRequest = context.messages.some(
            (m) => typeof m.content === "string" && m.content.includes("结构化摘要"),
          );
          if (isSummaryRequest) {
            yield { type: "text_delta", text: "压缩摘要" };
            yield { type: "done", stopReason: "end_turn" };
            return;
          }
          yield { type: "text_delta", text: "回复" };
          yield { type: "done", stopReason: "end_turn" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
      // 窗口：第一轮不撞线；第二轮（历史+1200 字大输入）撞线触发压缩；压缩后（摘要+恢复上下文）不再撞线
      compactConfig: { contextWindow: 300, maxOutputTokens: 30, safetyMargin: 20, keepRecentToolResults: 0 },
    });

    async function* inputs(): AsyncIterable<string> {
      yield "你好";
      yield "很长的问题".repeat(200);
      yield "压缩后继续";
      yield "/exit";
    }
    const outputs: string[] = [];
    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: (text) => outputs.push(text),
    });

    // 第二轮撞线压缩：删除了已落盘历史 → 重写整份盘 = agent 当前全部（摘要 + 本轮回复）
    const loaded = await store.loadSession(session.meta.id);
    const contents = loaded.getMessages().map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(contents[0]).toContain("【会话摘要】");
    expect(contents.some((c) => c === "你好")).toBe(false); // 旧历史被重写覆盖
    // 本轮（第二轮）回复在盘上，与 agent 内存一致（无遗漏）
    expect(loaded.getMessages().map((m) => m.role)).toEqual(agent.getMessages().map((m) => m.role));
    expect(outputs.join("")).toContain("[历史已压缩]");

    // 压缩后继续的一轮也正常落盘
    expect(contents.some((c) => c === "压缩后继续")).toBe(true);
    // assistant 回复（content 为数组）也在盘上
    expect(JSON.stringify(loaded.getMessages().map((m) => m.content))).toContain("回复");
  });

  it("interact 未知命令反馈帮助提示", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    const agent = new Agent({
      modelClient: mockTextClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
    });

    async function* inputs(): AsyncIterable<string> {
      yield "/nope";
      yield "/exit";
    }
    const outputs: string[] = [];
    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: (text) => outputs.push(text),
    });
    expect(outputs.join("")).toContain("[未知命令]");
  });
});

describe("buildCompactConfig 装配", () => {
  it("三级 fallback：config > 模型定义 > 默认 128000；未配置 compact 返回 undefined", () => {
    const modelsWithWindow = { resolve: () => ({ model: { contextWindow: 64000 } }) } as unknown as Models;
    // config 显式 contextWindow 优先
    expect(
      buildCompactConfig(configSchema.parse({ compact: { contextWindow: 100000, maxOutputTokens: 1000, safetyMargin: 100, keepRecentToolResults: 3 } }), "m", modelsWithWindow),
    ).toEqual({ contextWindow: 100000, maxOutputTokens: 1000, safetyMargin: 100, keepRecentToolResults: 3 });
    // 无 contextWindow：取模型定义值
    expect(buildCompactConfig(configSchema.parse({ compact: {} }), "m", modelsWithWindow)?.contextWindow).toBe(64000);
    // 模型也没有：默认 128000，其余字段用 schema 默认值
    const defaults = buildCompactConfig(configSchema.parse({ compact: {} }), "m");
    expect(defaults).toEqual({ contextWindow: 128000, maxOutputTokens: 8192, safetyMargin: 4096, keepRecentToolResults: 5 });
    // 未配置 compact：不启用
    expect(buildCompactConfig(configSchema.parse({}), "m")).toBeUndefined();
  });
});

describe("CLI 交互循环", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("逐行输入 → Agent 回复 → 消息持久化", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    const agent = new Agent({
      modelClient: mockTextClient("回复内容"),
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
    });

    async function* inputs(): AsyncIterable<string> {
      yield "你好";
      yield "再见";
      yield "/exit";
    }

    const outputs: string[] = [];
    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: (text) => outputs.push(text),
    });

    expect(outputs.join("")).toContain("回复内容");
    // 两轮对话：user + assistant × 2
    const loaded = await store.loadSession(session.meta.id);
    expect(loaded.getMessages()).toHaveLength(4);
    expect(loaded.getMessages()[0]).toEqual({ role: "user", id: expect.any(String), content: "你好" });
    expect(loaded.getMessages()[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "回复内容" }],
    });
  });

  it("/exit 退出交互，后续输入不再处理", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    const agent = new Agent({
      modelClient: mockTextClient("回复"),
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
    });

    async function* inputs(): AsyncIterable<string> {
      yield "你好";
      yield "/exit";
      yield "再见"; // 不应被处理
    }

    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: () => {},
    });

    const loaded = await store.loadSession(session.meta.id);
    // 只有 "你好" 一轮，/exit 后不再处理
    expect(loaded.getMessages()).toHaveLength(2);
    expect(loaded.getMessages()[0]).toEqual({ role: "user", id: expect.any(String), content: "你好" });
  });

  it("渲染思考、工具调用与工具结果", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    const readTool: Tool = {
      name: "read",
      description: "读取文件",
      inputSchema: z.object({ path: z.string() }),
      isReadOnly: true,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
      execute: () => "文件内容",
    };
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "thinking_delta", thinking: "分析中…" };
            yield { type: "toolcall_start", index: 0, id: "c1", name: "read" };
            yield { type: "toolcall_delta", index: 0, partialJson: '{"path":"a.ts"}' };
            yield { type: "toolcall_end", index: 0 };
            yield { type: "done", stopReason: "tool_calls" };
          } else {
            yield { type: "text_delta", text: "已读取" };
            yield { type: "done", stopReason: "end_turn" };
          }
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [readTool],
    });

    async function* inputs(): AsyncIterable<string> {
      yield "读文件";
      yield "/exit";
    }
    const outputs: string[] = [];
    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: (text) => outputs.push(text),
    });

    const out = outputs.join("");
    expect(out).toContain("分析中…"); // 思考渲染
    expect(out).toContain("[工具] read"); // 工具调用渲染
    expect(out).toContain("[工具结果] 文件内容"); // 工具结果渲染
  });

  it("渲染错误事件", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "minicode-cli-"));
    const store = new SessionStore(dir);
    const session = await store.createSession({ model: "mock" });
    const agent = new Agent({
      modelClient: {
        async *stream() {
          yield { type: "error", message: "流中断" };
          yield { type: "done", stopReason: "error" };
        },
      },
      modelId: "mock",
      systemPrompt: "助手",
      tools: [],
    });

    async function* inputs(): AsyncIterable<string> {
      yield "hi";
      yield "/exit";
    }
    const outputs: string[] = [];
    await interact({
      agent,
      store,
      session,
      inputs: inputs(),
      write: (text) => outputs.push(text),
    });

    expect(outputs.join("")).toContain("[错误] 流中断");
  });
});
