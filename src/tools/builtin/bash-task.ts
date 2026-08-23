import { z } from "zod";
import { validateInput } from "../base.js";
import type { Tool } from "../base.js";
import type { BackgroundTaskStatus } from "./bash-background.js";
import { getBackgroundTask, killBackgroundTask } from "./bash-background.js";

const schema = z.object({
  task_id: z.string(),
  /** status 查询状态与累积输出；kill 终止后台进程 */
  action: z.enum(["status", "kill"]),
});

const STATUS_TEXT: Record<BackgroundTaskStatus, string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  killed: "已终止",
};

/**
 * 后台 bash 任务管理工具（DESIGN 7.5）：模型拿 bash background 返回的任务 id，
 * 用本工具查询状态与累积输出、终止进程。
 */
export const bashTaskTool: Tool = {
  name: "bash_task",
  description: "查询或终止后台 bash 任务（配合 bash 工具的 background 参数使用）",
  inputSchema: schema,
  isReadOnly: false,
  requiresUserInteraction: false,
  maxResultSizeChars: 10000,
  async execute(input) {
    const { task_id, action } = validateInput<{ task_id: string; action: "status" | "kill" }>(
      bashTaskTool,
      input,
    );
    const task = getBackgroundTask(task_id);
    if (!task) {
      return `任务 ${task_id} 不存在`;
    }
    if (action === "kill") {
      killBackgroundTask(task_id);
      return `任务 ${task_id} 已终止`;
    }
    // status：状态行 + 累积输出
    const statusText = STATUS_TEXT[task.status];
    const exitText = task.exitCode !== undefined ? `（退出码 ${task.exitCode}）` : "";
    const line = `任务 ${task.id}：${statusText}${exitText}`;
    const output = task.output.trim();
    return output ? `${line}\n${output}` : line;
  },
};