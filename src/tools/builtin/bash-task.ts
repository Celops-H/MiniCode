import { z } from "zod";
import { validateInput } from "../base.js";
import type { Tool } from "../base.js";
import type { BackgroundTaskStatus } from "./bash-background.js";
import { getBackgroundTask, killBackgroundTask } from "./bash-background.js";

const schema = z.object({
  task_id: z.string(),
  /** status 查询状态与自上次查询的新增输出；kill 终止后台进程 */
  action: z.enum(["status", "kill"]),
});

const STATUS_TEXT: Record<BackgroundTaskStatus, string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  killed: "已终止",
};

/**
 * 后台 bash 任务管理工具：模型拿 bash background 返回的任务 id，
 * 用本工具查询状态与新增输出、终止进程。
 * status 只返回自上次查询以来的新增输出（带「新增/无新增」标注）：
 * 运行中且无新增时模型不会把旧输出当进展反复轮询。
 */
export const bashTaskTool: Tool = {
  name: "bash_task",
  description:
    "查询或终止后台 bash 任务（配合 bash 工具的 background 参数使用）。" +
    "status 只返回自上次查询以来的新增输出；任务结束后无需再查询",
  inputSchema: schema,
  isReadOnly: false,
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
      const killed = killBackgroundTask(task_id)!;
      // 守卫后对已完成/失败任务是无操作：按实际终态反馈，不再无条件宣称
      // 「已终止」与后续 status 查询自相矛盾（上方 getBackgroundTask 已确认任务存在）
      if (killed.status !== "killed") {
        const exitText = killed.exitCode !== undefined ? `（退出码 ${killed.exitCode}）` : "";
        return `任务 ${task_id} 已于先前结束：${STATUS_TEXT[killed.status]}${exitText}，无需终止`;
      }
      return `任务 ${task_id} 已终止`;
    }
    // status：状态行 + 自上次查询以来的新增输出（游标推进，旧输出不重复返回）
    const statusText = STATUS_TEXT[task.status];
    const exitText = task.exitCode !== undefined ? `（退出码 ${task.exitCode}）` : "";
    const line = `任务 ${task.id}：${statusText}${exitText}`;
    const fresh = task.output.slice(task.readMark).trim();
    task.readMark = task.output.length;
    if (fresh) return `${line}\n自上次查询的新增输出：\n${fresh}`;
    if (task.status === "running") return `${line}\n（自上次查询无新增输出）`;
    return `${line}\n（任务已结束，无新增输出，无需再查询）`;
  },
};