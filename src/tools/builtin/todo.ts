import { z } from "zod";
import type { Tool } from "../base.js";

const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

const todoSchema = z.object({
  /** 完整待办列表：整体替换当前清单 */
  todos: z.array(
    z.object({
      content: z.string(),
      status: z.enum(TODO_STATUSES).optional(),
    }),
  ),
});

/** 创建 todo 工具（每次调用独立实例，维护会话内待办清单） */
export function createTodoTool(): Tool {
  let current: TodoItem[] = [];
  return {
    name: "todo",
    description: "维护任务待办清单：传入完整待办列表整体替换，返回最新清单",
    inputSchema: todoSchema,
    isReadOnly: false,
    requiresUserInteraction: false,
    maxResultSizeChars: 10000,
    async execute(input) {
      const { todos } = todoSchema.parse(input);
      current = todos.map((item, i) => ({
        id: `t${i + 1}`,
        content: item.content,
        status: item.status ?? "pending",
      }));
      return formatTodos(current);
    },
  };
}

function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "(待办清单为空)";
  return todos.map((t) => `${t.id} [${t.status}] ${t.content}`).join("\n");
}
