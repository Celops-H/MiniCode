import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, type ModelClient } from "../../src/agent/index.js";
import { PRUNED_MARKER } from "../../src/context/index.js";
import type { ToolResultMessage } from "../../src/core/index.js";
import { readTool } from "../../src/tools/index.js";

describe("read 读去重（Agent 链路）", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** 依调用序：前两次发 read 工具调用，之后收尾文本。与上下文无关，便于断言两次读的差异 */
  function readTwiceThenText(file: string): ModelClient {
    let call = 0;
    return {
      async *stream() {
        call++;
        if (call <= 2) {
          yield { type: "toolcall_start", index: 0, id: `r${call}`, name: "read" };
          yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ path: file }) };
          yield { type: "toolcall_end", index: 0 };
          yield { type: "done", stopReason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "完成" };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
  }

  function makeFile(): string {
    dir = mkdtempSync(path.join(tmpdir(), "read-dedup-"));
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "正文内容");
    return file;
  }

  function results(agent: Agent): ToolResultMessage[] {
    return agent.getMessages().filter((m): m is ToolResultMessage => m.role === "tool_result");
  }

  it("同区间重复读：第二次回 stub，不重复回灌全文", async () => {
    const file = makeFile();
    const agent = new Agent({
      modelClient: readTwiceThenText(file),
      modelId: "mock",
      systemPrompt: "助手",
      tools: [readTool],
    });
    agent.start("读文件");
    for await (const _ of agent.run()) {
      // 消费事件流
    }

    const toolResults = results(agent);
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]!.content).toBe("1\t正文内容");
    expect(toolResults[1]!.content).toContain("文件未变化");
    expect(toolResults[1]!.content).not.toContain("正文内容");
  });

  it("旧结果被修剪后同区间重读必须回全文", async () => {
    const file = makeFile();
    const agent = new Agent({
      modelClient: readTwiceThenText(file),
      modelId: "mock",
      systemPrompt: "助手",
      tools: [readTool],
      // 窗口放大：裁剪后不再触发摘要，只走裁剪这一层；
      // 关掉压缩后回注（restoreMaxFiles: 0）：本用例钉的是 E248 的口径——
      // 被摘除的读记录不得让同区间重读回 stub，故不走回注路径
      compactConfig: {
        contextWindow: 1_000_000,
        maxOutputTokens: 100,
        safetyMargin: 100,
        keepRecentToolResults: 0,
        restoreMaxFiles: 0,
        restoreMaxCharsPerFile: 5000,
        restoreMaxTotalChars: 50000,
      },
    });
    agent.start("读文件");
    for await (const _ of agent.runTurn()) {
      // 第 1 轮：read 工具结果入上下文
    }
    // 手动压缩：裁剪把读结果换成裁剪标记（keepRecentToolResults=0）
    await agent.compactNow();
    expect(agent.getMessages().some((m) => m.role === "tool_result" && m.content === PRUNED_MARKER)).toBe(true);

    for await (const _ of agent.runTurn()) {
      // 第 2 轮：同区间重读
    }

    const last = results(agent).at(-1)!;
    expect(last.content).toBe("1\t正文内容");
  });
});
