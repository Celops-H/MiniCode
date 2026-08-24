import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, type ModelClient } from "../../src/agent/index.js";
import { z } from "zod";
import { withCwd, resolvePath, currentCwd } from "../../src/tools/file-state.js";

describe("工具执行上下文 cwd（DESIGN 4.2）", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("resolvePath：相对路径基于上下文 cwd，绝对路径原样", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cwd-"));
    await withCwd(dir, () => {
      expect(resolvePath("a.txt")).toBe(path.join(dir, "a.txt"));
      expect(resolvePath("./x/y.txt")).toBe(path.join(dir, "x", "y.txt"));
    });
    expect(resolvePath("a.txt")).toBe(path.resolve("a.txt")); // 上下文外退回进程 cwd
    expect(resolvePath("/abs/path.txt")).toBe("/abs/path.txt");
  });

  it("Agent 指定 cwd：read/write/bash 在 cwd 内工作", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cwd-"));
    const workdir = path.join(dir, "workspace");
    mkdirSync(workdir, { recursive: true });
    const toolsSeen: string[] = [];
    const agent = new Agent({
      modelClient: {
        async *stream(_modelId, context) {
          toolsSeen.push(...context.tools.map((t) => t.name));
          const hasResult = context.messages.some((m) => m.role === "tool_result");
          if (!hasResult) {
            yield { type: "toolcall_start", index: 0, id: "c1", name: "write" };
            yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ path: "out.txt", content: "数据" }) };
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
      cwd: workdir,
      tools: [
        {
          name: "write",
          description: "写文件",
          inputSchema: z.object({ path: z.string(), content: z.string() }),
          isReadOnly: false,
          requiresUserInteraction: false,
          maxResultSizeChars: 100,
          execute: async (input) => {
            const { path: p, content } = input as { path: string; content: string };
            // 工具经 resolvePath 解析相对路径（真实 writeTool 行为）
            const file = resolvePath(p);
            writeFileSync(file, content, "utf8");
            return `已写入 ${file}`;
          },
        },
      ],
    });
    agent.start("写文件");
    for await (const _ of agent.run()) {
      // 消费
    }
    // 相对路径写入到 cwd 下（而非进程 cwd）
    expect(await import("node:fs/promises").then((fs) => fs.readFile(path.join(workdir, "out.txt"), "utf8"))).toBe("数据");
    const result = agent.getMessages().find((m) => m.role === "tool_result");
    expect(String(result?.content)).toContain(path.join(workdir, "out.txt"));
  });

  it("currentCwd：无上下文时退回进程 cwd", () => {
    expect(currentCwd()).toBe(process.cwd());
  });
});