import { describe, expect, it } from "vitest";
import { PRUNED_MARKER, pruneToolResults } from "../../src/context/index.js";
import { toolResultMessage, userMessage } from "../../src/core/index.js";

function result(id: string, content: string) {
  return toolResultMessage(`call_${id}`, "read", content);
}

describe("pruneToolResults（历史裁剪）", () => {
  it("裁剪最旧工具输出，保留最近若干条完整输出", () => {
    const messages = [result("1", "输出1"), result("2", "输出2"), result("3", "输出3")];
    const pruned = pruneToolResults(messages, 1);
    expect(pruned.map((m) => m.content)).toEqual([PRUNED_MARKER, PRUNED_MARKER, "输出3"]);
  });

  it("工具结果不足保留数时不裁剪", () => {
    const messages = [result("1", "输出1"), result("2", "输出2")];
    expect(pruneToolResults(messages, 3)).toBe(messages);
  });

  it("只替换工具结果内容，不修改其他消息", () => {
    const messages = [userMessage("问题"), result("1", "输出1"), result("2", "输出2")];
    const pruned = pruneToolResults(messages, 1);
    expect(pruned[0]).toEqual({ role: "user", content: "问题" });
    expect(pruned[1]!.content).toBe(PRUNED_MARKER);
    expect(pruned[2]!.content).toBe("输出2");
  });

  it("裁剪后消息结构完整（保留 toolCallId 配对骨架）", () => {
    const messages = [result("1", "长输出1"), result("2", "长输出2")];
    const pruned = pruneToolResults(messages, 0);
    expect(pruned).toHaveLength(2);
    expect(pruned[0]).toMatchObject({ role: "tool_result", toolCallId: "call_1" });
    expect(pruned[0]!.content).toBe(PRUNED_MARKER);
  });

  it("裁剪会清除失败标记（已裁剪无错误语义）", () => {
    const messages = [
      { ...result("1", "失败"), isError: true },
      { ...result("2", "成功"), isError: false },
    ];
    const pruned = pruneToolResults(messages, 1);
    expect(pruned[0]).toMatchObject({ role: "tool_result", isError: false });
  });

  it("原数组不被修改", () => {
    const messages = [result("1", "输出1"), result("2", "输出2")];
    pruneToolResults(messages, 1);
    expect(messages[0]!.content).toBe("输出1");
  });
});
