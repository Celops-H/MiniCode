import { z } from "zod";
import { validateInput, outputLimitNote } from "../base.js";
import type { Tool } from "../base.js";
import type { BackgroundTask, BackgroundTaskStatus } from "./bash-background.js";
import { getBackgroundTask, killBackgroundTask } from "./bash-background.js";

const MAX_RESULT_CHARS = 10000;

const schema = z.object({
  task_id: z.string().describe("bash 后台启动（background 参数）时返回的任务 id"),
  action: z.enum(["status", "kill"]).describe("status 查询状态与自上次查询的新增输出；kill 终止后台进程"),
});

const STATUS_TEXT: Record<BackgroundTaskStatus, string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  killed: "已终止",
};

/**
 * 任务状态的文字描述：状态名，随后按有无追加退出码与启动错误。
 * 启动错误（spawn 失败，如 shell 不可用）必须带出：只报「失败」时模型
 * 无从判断能否重试。两者互不排斥，缺哪个不写哪个。
 * @param task 后台任务
 * @returns 状态描述文本
 */
export function taskStateText(task: BackgroundTask): string {
  const exitText = task.exitCode !== undefined ? `（退出码 ${task.exitCode}）` : "";
  const errorText = task.error ? ` · 启动错误：${task.error}` : "";
  return `${STATUS_TEXT[task.status]}${exitText}${errorText}`;
}

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
    "status 只返回自上次查询以来的新增输出；任务结束后无需再查询。" +
    outputLimitNote(MAX_RESULT_CHARS),
  inputSchema: schema,
  isReadOnly: false,
  maxResultSizeChars: MAX_RESULT_CHARS,
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
        return `任务 ${task_id} 已于先前结束：${taskStateText(killed)}，无需终止`;
      }
      return `任务 ${task_id} 已终止`;
    }
    // status：状态行 + 自上次查询以来的新增输出（游标推进，旧输出不重复返回）
    const line = `任务 ${task.id}：${taskStateText(task)}`;
    const fresh = task.output.slice(task.readMark).trim();
    task.readMark = task.output.length;
    if (fresh) return `${line}\n自上次查询的新增输出：\n${fresh}`;
    if (task.status === "running") return `${line}\n（自上次查询无新增输出）`;
    return `${line}\n（任务已结束，无新增输出，无需再查询）`;
  },
};