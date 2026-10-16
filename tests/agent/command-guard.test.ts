/**
 * bash 同命令熔断：模型反复重跑同一条失败命令时，harness 必须自己停下来逼它改道，
 * 不能无限重试。这里用假 bash 工具喂预设结果，驱动 Agent 主循环钉住计数口径：
 * 带原因的失败累加、成功清零、用户打断既不计入也不清零、换参数算另一条命令；
 * 熔断判定先于权限审批。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/index.js";
import type { ModelClient } from "../../src/agent/index.js";
import { HookBus } from "../../src/hooks/index.js";
import { PermissionPipeline } from "../../src/permission/index.js";
import type { ExecuteResult, Tool } from "../../src/tools/index.js";

/** 一次执行结果：失败带原因、失败不带原因（用户打断）、成功 */
type Step = "fail" | "aborted" | "ok";

const FAILURE: ExecuteResult = {
  output: "命令失败：退出码 1\n[不可重试] 同一命令重跑结果不变，请先修正命令",
  isError: true,
  error: "命令失败：退出码 1",
};

/** 假 bash 工具：按调用次序取 results[i]，超出即复用最后一项 */
function makeBashTool(results: Step[]): { tool: Tool; executed: () => number } {
  let calls = 0;
  const tool: Tool = {
    name: "bash",
    description: "执行命令",
    inputSchema: z.object({ command: z.string() }),
    isReadOnly: false,
    maxResultSizeChars: 30000,
    execute: () => {
      const step = results[Math.min(calls, results.length - 1)] ?? "fail";
      calls += 1;
      if (step === "aborted") return { output: "(命令已被用户打断)", isError: true };
      if (step === "ok") return "命令输出";
      return FAILURE;
    },
  };
  return { tool, executed: () => calls };
}

/** 逐轮发工具调用的模型：前 commands.length 轮各发一次，之后文本收尾 */
function scriptedModel(commands: string[]): ModelClient {
  return {
    async *stream(_modelId, context) {
      const done = context.messages.filter((m) => m.role === "tool_result").length;
      const command = commands[done];
      if (command !== undefined) {
        yield { type: "toolcall_start", index: 0, id: `call_${done + 1}`, name: "bash" };
        yield { type: "toolcall_delta", index: 0, partialJson: JSON.stringify({ command }) };
        yield { type: "toolcall_end", index: 0 };
        yield { type: "done", stopReason: "tool_calls" };
      } else {
        yield { type: "text_delta", text: "结束" };
        yield { type: "done", stopReason: "end_turn" };
      }
    },
  };
}

async function runAgent(
  results: Step[],
  commands: string[],
  permission?: PermissionPipeline,
): Promise<{
  contents: string[];
  errors: boolean[];
  eventOutputs: string[];
  executed: number;
}> {
  const { tool, executed } = makeBashTool(results);
  // PostToolUse 走事件总线：收集事件里的 output，核对熔断提示不只进回灌消息
  const hooks = new HookBus();
  const eventOutputs: string[] = [];
  hooks.on("PostToolUse", (event) => {
    eventOutputs.push(event.output);
  });
  const agent = new Agent({
    modelClient: scriptedModel(commands),
    modelId: "mock",
    systemPrompt: "助手",
    hooks,
    tools: [tool],
    permission,
  });
  agent.start("跑命令");
  for await (const _ of agent.run()) {
    // 消费事件流
  }
  const toolResults = agent
    .getMessages()
    .filter((m) => m.role === "tool_result")
    .map((m) => m as { content: string; isError: boolean });
  return {
    contents: toolResults.map((m) => m.content),
    errors: toolResults.map((m) => m.isError),
    eventOutputs,
    executed: executed(),
  };
}

describe("Agent 同命令熔断", () => {
  it("同一命令连续失败 3 次：第 3 次回灌与事件都附熔断提示，第 4 次不再执行", async () => {
    const { contents, errors, eventOutputs, executed } = await runAgent(["fail"], ["x", "x", "x", "x"]);
    expect(executed).toBe(3);
    expect(contents[0]).not.toContain("[熔断]");
    expect(contents[1]).not.toContain("[熔断]");
    expect(contents[2]).toContain("[熔断]");
    expect(contents[2]).toContain("命令失败：退出码 1");
    // 熔断提示同时进事件（界面卡片与轨迹看得到），不只进回灌消息
    expect(eventOutputs[2]).toContain("[熔断]");
    // 第 4 次被拒绝：未执行，回灌拒绝文案
    expect(contents[3]).toContain("命令未执行");
    expect(errors).toEqual([true, true, true, true]);
  });

  it("熔断拒绝后该命令计数清零：下一次相同命令照常执行，不永久封死", async () => {
    const { contents, executed } = await runAgent(["fail"], ["x", "x", "x", "x", "x"]);
    expect(executed).toBe(4);
    expect(contents[3]).toContain("命令未执行");
    expect(contents[4]).toContain("命令失败：退出码 1");
    expect(contents[4]).not.toContain("命令未执行");
  });

  it("用户打断不计入也不清零：失败 2 次、打断 1 次、再失败 1 次即熔断", async () => {
    const { contents, executed } = await runAgent(
      ["fail", "fail", "aborted", "fail"],
      ["x", "x", "x", "x", "x"],
    );
    // 若打断把计数清零，第 4 次只算第 1 次失败，第 5 次会照常执行（executed 为 5）
    expect(executed).toBe(4);
    expect(contents[2]).not.toContain("[熔断]");
    expect(contents[3]).toContain("[熔断]");
    expect(contents[4]).toContain("命令未执行");
  });

  it("命令成功清零该命令计数：三次失败被一次成功隔开，重新计数", async () => {
    const { contents, executed } = await runAgent(
      ["fail", "fail", "ok", "fail", "fail", "fail"],
      ["x", "x", "x", "x", "x", "x", "x"],
    );
    expect(executed).toBe(6);
    expect(contents[2]).not.toContain("[熔断]");
    expect(contents[5]).toContain("[熔断]");
    expect(contents[6]).toContain("命令未执行");
  });

  it("不同命令各记各的：两条命令交替各失败 2 次，都不触发熔断", async () => {
    const { contents, executed } = await runAgent(
      ["fail"],
      ["a", "b", "a", "b"],
    );
    // 共用一个计数器的话第 4 次已熔断（executed 为 3），按命令分别计数才照常执行
    expect(executed).toBe(4);
    expect(contents.every((c) => !c.includes("[熔断]"))).toBe(true);
  });

  it("熔断判定先于权限审批：被熔断的命令不再进入审批", async () => {
    let approvals = 0;
    const permission = new PermissionPipeline({
      rules: [],
      approver: async () => {
        approvals += 1;
        return { action: "allow" };
      },
    });
    const { contents, executed } = await runAgent(["fail"], ["x", "x", "x", "x"], permission);
    // 前三次失败各审批一次；第四次已达阈值，熔断拒绝发生在审批之前，用户不再被弹窗
    expect(approvals).toBe(3);
    expect(executed).toBe(3);
    expect(contents[3]).toContain("命令未执行");
  });
});
