import { describe, expect, it } from "vitest";
import { createTodoTool } from "../../src/tools/index.js";

describe("todo 工具", () => {
  it("整体替换待办清单并返回格式化结果", async () => {
    const todo = createTodoTool();
    const out = await todo.execute({
      todos: [{ content: "写消息模型" }, { content: "写适配器", status: "in_progress" }],
    });
    expect(out).toContain("t1 [pending] 写消息模型");
    expect(out).toContain("t2 [in_progress] 写适配器");
  });

  it("再次调用整体替换（支持增删改状态）", async () => {
    const todo = createTodoTool();
    await todo.execute({ todos: [{ content: "旧任务", status: "completed" }] });
    const out = await todo.execute({
      todos: [
        { content: "新任务" },
        { content: "旧任务", status: "completed" },
      ],
    });
    expect(out).toContain("t1 [pending] 新任务");
    expect(out).toContain("t2 [completed] 旧任务");
  });

  it("空清单返回提示", async () => {
    const todo = createTodoTool();
    const out = await todo.execute({ todos: [] });
    expect(out).toBe("(待办清单为空)");
  });
});
