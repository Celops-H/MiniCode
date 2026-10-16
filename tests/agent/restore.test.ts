import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, type CompactConfig, type ModelClient } from "../../src/agent/index.js";
import {
  PRUNED_MARKER,
  RESTORE_MARKER,
  SUMMARY_MARKER,
  estimateTextTokens,
  estimateTokens,
  needsCompact,
} from "../../src/context/index.js";
import type { Message, ToolResultMessage, UserMessage } from "../../src/core/index.js";
import { readTool } from "../../src/tools/index.js";

/** 压缩配置：窗口放大到只走裁剪层，裁剪保留数与回注预算按用例给 */
function compactConfig(keepRecentToolResults: number, restore: Partial<CompactConfig> = {}): CompactConfig {
  return {
    contextWindow: 1_000_000,
    maxOutputTokens: 100,
    safetyMargin: 100,
    keepRecentToolResults,
    restoreMaxFiles: 5,
    restoreMaxCharsPerFile: 5000,
    restoreMaxTotalChars: 50000,
    ...restore,
  };
}

describe("压缩后回注最近读过的文件（Agent 链路）", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function write(name: string, content: string): string {
    if (!dir) dir = mkdtempSync(path.join(tmpdir(), "restore-"));
    const file = path.join(dir, name);
    writeFileSync(file, content);
    return file;
  }

  /** 依调用序：前几次各发一次 read 工具调用（路径取自入参），之后收尾文本 */
  function readThenText(paths: (string | undefined)[]): ModelClient {
    let call = 0;
    return {
      async *stream() {
        const target = paths[call++];
        if (target !== undefined) {
          yield { type: "toolcall_start", index: 0, id: `r${call}`, name: "read" };
          yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ path: target }) };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "完成" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
  }

  async function turn(agent: Agent): Promise<void> {
    for await (const _ of agent.runTurn()) {
      // 消费事件流
    }
  }

  function restoreMessage(agent: Agent): UserMessage | undefined {
    return agent
      .getMessages()
      .find((m): m is UserMessage => m.role === "user" && m.content.startsWith(RESTORE_MARKER));
  }

  function toolResults(agent: Agent): ToolResultMessage[] {
    return agent.getMessages().filter((m): m is ToolResultMessage => m.role === "tool_result");
  }

  function makeAgent(modelClient: ModelClient, config: CompactConfig): Agent {
    return new Agent({ modelClient, modelId: "mock", systemPrompt: "助手", tools: [readTool], compactConfig: config });
  }

  it("裁剪把读结果清出上下文后，回注该文件的当前内容", async () => {
    const file = write("a.txt", "正文内容");
    const agent = makeAgent(readThenText([file]), compactConfig(0));
    agent.start("读文件");
    await turn(agent);

    await agent.compactNow();

    const messages = agent.getMessages();
    expect(messages.some((m) => m.role === "tool_result" && m.content === PRUNED_MARKER)).toBe(true);
    const restored = restoreMessage(agent);
    expect(restored).toBeDefined();
    expect(restored!.source).toBe("system");
    expect(restored!.content).toContain(`文件：${file}`);
    expect(restored!.content).toContain("1\t正文内容");
  });

  it("结果仍在上下文的读不回注，只回注被清出的", async () => {
    const a = write("a.txt", "甲");
    const b = write("b.txt", "乙");
    const agent = makeAgent(readThenText([a, b]), compactConfig(1));
    agent.start("读两个文件");
    await turn(agent);
    await turn(agent);

    // 裁剪保留最近 1 条：a 的结果被换成裁剪标记，b 的结果仍在上下文
    await agent.compactNow();

    const restored = restoreMessage(agent);
    expect(restored).toBeDefined();
    expect(restored!.content).toContain("a.txt");
    expect(restored!.content).not.toContain("b.txt");
  });

  it("回注后同区间重读回 stub：读记录重登记到回注消息", async () => {
    const file = write("a.txt", "正文内容");
    const agent = makeAgent(readThenText([file, file]), compactConfig(0));
    agent.start("读文件");
    await turn(agent);

    await agent.compactNow();
    await turn(agent);

    const results = toolResults(agent);
    expect(restoreMessage(agent)).toBeDefined();
    expect(results).toHaveLength(2);
    expect(results.at(-1)!.content).toContain("文件未变化");
    expect(results.at(-1)!.content).not.toContain("正文内容");
  });

  it("回注条数上限生效：只回注最近读过的若干个", async () => {
    const a = write("a.txt", "甲");
    const b = write("b.txt", "乙");
    const agent = makeAgent(readThenText([a, b]), compactConfig(0, { restoreMaxFiles: 1 }));
    agent.start("读两个文件");
    await turn(agent);
    await turn(agent);

    await agent.compactNow();

    const restored = restoreMessage(agent);
    expect(restored).toBeDefined();
    expect(restored!.content).toContain("b.txt");
    expect(restored!.content).not.toContain("a.txt");
  });

  it("回注被截断的文件不登记：同区间重读仍回全文", async () => {
    const file = write("a.txt", "正文内容");
    // 单文件上限小于路径行长度，回注只剩截断说明，据此不登记去重记录
    const agent = makeAgent(readThenText([file, file]), compactConfig(0, { restoreMaxCharsPerFile: 8 }));
    agent.start("读文件");
    await turn(agent);

    await agent.compactNow();
    expect(restoreMessage(agent)!.content).toContain("文件过长");
    await turn(agent);

    expect(toolResults(agent).at(-1)!.content).toBe("1\t正文内容");
  });

  it("文件已删除时跳过回注，压缩照常完成", async () => {
    const file = write("gone.txt", "内容");
    const agent = makeAgent(readThenText([file]), compactConfig(0));
    agent.start("读文件");
    await turn(agent);

    rmSync(file);
    await agent.compactNow();

    expect(restoreMessage(agent)).toBeUndefined();
    expect(agent.getMessages().some((m) => m.role === "tool_result" && m.content === PRUNED_MARKER)).toBe(true);
  });

  it("剩余空间不足时不回注：回注预算受压缩阈值收紧", async () => {
    const file = write("a.txt", "内容".repeat(200));
    // 可用窗口 80 token，读结果已被裁剪后上下文仍占大半，装不下正文
    const agent = makeAgent(readThenText([file]), compactConfig(0, {
      contextWindow: 120,
      maxOutputTokens: 20,
      safetyMargin: 20,
    }));
    agent.start("读文件");
    await turn(agent);

    await agent.compactNow();

    expect(agent.getMessages().some((m) => m.role === "tool_result" && m.content === PRUNED_MARKER)).toBe(true);
    expect(restoreMessage(agent)).toBeUndefined();
  });

  it("回注预算按剩余空间保守折算：回注后真实水位不越压缩阈值，下一轮不再压缩", async () => {
    // 回注正文按单文件上限截断到 600 字符：旧口径下占满剩余空间（约 740 字符），
    // 保守折算到一半（约 370）后装不下本条，故不再回注——宁可少回注也不顶线
    const file = write("大.txt", "内容内容内容\n".repeat(200));
    const config = compactConfig(0, {
      contextWindow: 1000,
      maxOutputTokens: 100,
      safetyMargin: 100,
      restoreMaxCharsPerFile: 600,
      restoreMaxTotalChars: 100000,
    });
    let summaryCalls = 0;
    let call = 0;
    // 估算口径不含工具定义等请求开销：模拟真实用量比估算高 OVERHEAD
    const OVERHEAD = 500;
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        if (context.tools.length === 0) {
          summaryCalls++;
          yield { type: "text_delta", text: "摘要正文" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        call++;
        const usage = {
          promptTokens:
            estimateTokens(context.messages) + estimateTextTokens(context.systemPrompt) + OVERHEAD,
        };
        if (call === 1) {
          yield { type: "toolcall_start", index: 0, id: "r1", name: "read" };
          yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ path: file }) };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls", usage };
          return;
        }
        yield { type: "text_delta", text: "完成" };
        yield { type: "done", stopReason: "end_turn", usage };
      },
    };
    const agent = makeAgent(modelClient, config);
    agent.start("读文件");
    await turn(agent); // 第 1 轮：读文件
    await agent.compactNow(); // 裁剪 + 回注
    agent.start("继续");
    await turn(agent); // 第 2 轮：带回注的真实用量回填
    agent.start("再继续");
    await turn(agent); // 第 3 轮：水位不越线则不再压缩

    expect(summaryCalls).toBe(0);
    expect(needsCompact(agent.contextTokens(), config)).toBe(false);
  });

  it("摘要压缩后同样回注，增量摘要的增量不含回注正文", async () => {
    const file = write("a.txt", "正文内容");
    const summaryRequests: Message[][] = [];
    let calls = 0;
    const modelClient: ModelClient = {
      async *stream(_modelId, context) {
        if (context.tools.length === 0) {
          // 摘要调用：工具列表为空
          summaryRequests.push(context.messages);
          yield { type: "text_delta", text: "摘要正文" };
          yield { type: "done", stopReason: "end_turn" };
          return;
        }
        calls++;
        if (calls === 1) {
          yield { type: "toolcall_start", index: 0, id: "r1", name: "read" };
          yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ path: file }) };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "完成" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const agent = makeAgent(modelClient, compactConfig(0));
    agent.start("读文件");
    await turn(agent);

    // 带压缩指导必走摘要层：读结果整段被摘要替换，回注随即载入
    await agent.compactNow("侧重保留命令输出");
    expect(agent.getMessages()[0]).toMatchObject({
      role: "user",
      source: "system",
      content: expect.stringContaining(SUMMARY_MARKER),
    });
    expect(restoreMessage(agent)).toBeDefined();

    agent.start("继续做");
    await turn(agent);
    // 再来一次压缩（无指导且已有摘要 → 增量合并）：增量只取摘要之后的真实对话，
    // 回注正文源自压缩前历史、已被旧摘要覆盖，不进增量
    await agent.compactNow();

    const lastSummary = summaryRequests.at(-1)!;
    expect(lastSummary.some((m) => m.role === "user" && m.content.startsWith(RESTORE_MARKER))).toBe(false);
    expect(lastSummary.some((m) => m.role === "user" && m.content.includes("继续做"))).toBe(true);
  });
});
