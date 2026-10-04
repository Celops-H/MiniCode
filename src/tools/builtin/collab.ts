/**
 * 多 Agent 协作工具：spawn_agent / send_message / followup_task / list_agents。
 * 只在多 agent 环境注册（AgentOptions.team 传入时由 Agent 构造注册），普通单 agent 会话不可见。
 * 权限：send_message / list_agents 免审批（skipsPermission）；
 * spawn_agent / followup_task 走正常审批链。
 */
import { z } from "zod";
import type { Tool } from "../base.js";
import type { Agent } from "../../agent/agent.js";
import { AgentPath } from "../../agent/agent-path.js";
import type { Team } from "../../agent/team.js";
import type { MailMessage } from "../../agent/mailbox.js";

/** 协作工具名集合（子 agent 工具集过滤与识别用，避免重复注册） */
export const COLLAB_TOOL_NAMES = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
  "list_agents",
  "wait_agent",
  "interrupt_agent",
]);

/** 团队工作 agent 系统提示词（fork_turns=none：全新上下文，无父历史） */
export const COLLAB_SUBAGENT_PROMPT =
  "你是团队工作 agent，由协调者派生执行分派的任务。你看不到协调者的完整历史，只收到任务消息。" +
  "完成任务后用简洁文字说明结论。";

/** 只读子 agent 提示词附加段（只读派生时拼在协作提示之后） */
export const READONLY_SUBAGENT_PROMPT =
  "你是只读 agent：不能写文件、不能执行改状态的命令（写类工具与 bash 写命令会被拒绝），" +
  "只做读取、检索与推导，结论全部用文字回传，不要尝试落盘中间产物。";

/** agent 名命名约束（与 agent-path.ts 的段名校验一致，schema 层前置拦截） */
const AGENT_NAME_PATTERN = /^[a-z0-9_]+$/;

/**
 * 失败结果：协作工具的守卫失败（名字/路径/深度等）统一按失败回灌，
 * 父 agent 才能把命名失败、深度超限当失败处理而不是当正常结果消费
 */
function failure(text: string): { output: string; isError: true } {
  return { output: text, isError: true };
}

export interface CollabDeps {
  team: Team;
  /** 当前 agent 在团队中的路径（未注册时返回 undefined，按 root 处理） */
  getAgentPath: () => AgentPath | undefined;
  /** 当前 agent 是否只读（只读派生强制继承：只读 agent 派生的子 agent 恒为只读） */
  isReadOnly: () => boolean;
  /** 创建协作子 agent（运行时继承 + 工具集组装由 Agent 内部完成）；
   *  worktree 为派生时的隔离选择（缺省随全局缺省，见 worktreeDefault）；
   *  readOnly 为 spawn 只读声明 */
  createChildAgent: (agentName: string, path: AgentPath, worktree: boolean | undefined, readOnly: boolean) => Agent;
  /** 投递消息到目标 agent（Team.sendMessage，triggerTurn 时自动后台驱动） */
  sendMessage: (target: AgentPath, mail: MailMessage) => Promise<string | undefined>;
  /** worktree 隔离的全局缺省（spawn 工具 worktree 参数缺省随它） */
  worktreeDefault: () => boolean;
}

/** 多 Agent 协作工具集合 */
export function createCollaborationTools(deps: CollabDeps): Tool[] {
  return [
    spawnAgentTool(deps),
    sendMessageTool(deps),
    followupTaskTool(deps),
    listAgentsTool(deps),
    waitAgentTool(deps),
    interruptAgentTool(deps),
  ];
}

/** 派生子 agent 并下达初始任务（NEW_TASK 唤醒目标），走正常审批链 */
function spawnAgentTool(deps: CollabDeps): Tool {
  return {
    name: "spawn_agent",
    description:
      "派生一个子 agent 并下达初始任务：子 agent 有全新上下文（看不到你的历史）、继承团队运行时，" +
      "任务会唤醒它开始执行，完成后结论会自动回灌给你；受团队并发上限与 spawn 深度上限约束。" +
      "agent 名只能用小写字母、数字和下划线。" +
      "readOnly 为 true 时子 agent 只读：写类工具与 bash 写命令会被权限层拒绝，" +
      "审查、代码调研等不改文件的任务固定用只读派生；只读 agent 派生的子 agent 强制只读。" +
      "prompt 里写明证据要求：让子 agent 回传执行的原始命令与关键输出片段，涉及的文件一律用绝对路径，" +
      "只回摘要的结论你无法核实。" +
      "worktree 参数控制是否给子 agent 独立的 git worktree 工作区（缺省随全局设置）：会写文件的任务建议开启，" +
      "避免并行写冲突；纯只读任务不必。隔离不可用时子 agent 与你共享工作目录，结果中会注明。" +
      "只有当任务能具体、独立成子任务且与你的本地工作并行推进时才派生，否则继续本地处理；" +
      "多个互不依赖的子任务可在同一轮并行派生，等待期间可继续做不依赖它们结果的本地工作，" +
      "需要等结果时用 wait_agent",
    inputSchema: z.object({
      agentName: z.string().regex(AGENT_NAME_PATTERN, "agent 名只能用小写字母、数字和下划线"),
      prompt: z.string(),
      worktree: z.boolean().optional(),
      readOnly: z.boolean().optional(),
    }),
    isReadOnly: false,
    maxResultSizeChars: 500,
    execute: async (input) => {
      const { agentName, prompt, worktree, readOnly } = input as {
        agentName: string;
        prompt: string;
        worktree?: boolean;
        readOnly?: boolean;
      };
      if (!prompt.trim()) return failure("任务内容不能为空");
      const parentPath = deps.getAgentPath() ?? AgentPath.root();
      const path = deps.team.reserveSpawn(parentPath, agentName);
      if (typeof path === "string") return failure(path); // 守卫失败：按失败回灌，父 agent 可据此调整
      // 只读子 agent 不写文件，worktree 隔离无意义（git worktree add 本身改仓库状态），强制不建
      const wantReadOnly = readOnly === true || deps.isReadOnly();
      const wantWorktree = wantReadOnly ? false : (worktree ?? deps.worktreeDefault());
      try {
        const child = deps.createChildAgent(agentName, path, wantWorktree, wantReadOnly);
        deps.team.commitSpawn(path, child);
        const error = await deps.sendMessage(path, {
          type: "NEW_TASK",
          from: parentPath,
          content: prompt,
          triggerTurn: true,
        });
        if (error) return failure(error);
        // 要求隔离但未生效（非 git 仓库/创建失败）：结果中注明退化，父 agent 不误以为已隔离
        if (wantWorktree && deps.team.getWorktree(path) === undefined) {
          return `已派生 ${path}，初始任务已下达；worktree 隔离未生效（当前目录不是 git 仓库或创建失败），子 agent 与你共享工作目录`;
        }
        // 只读派生显式带了 worktree：已忽略（见上），结果中注明防父误以为有隔离
        if (wantReadOnly) {
          const note = worktree === true ? "；worktree 隔离已忽略（只读任务不写文件）" : "";
          return `已派生 ${path}（只读），初始任务已下达${note}`;
        }
        return `已派生 ${path}，初始任务已下达`;
      } catch (err) {
        // 创建/投递中途失败：释放已预留的 spawn 槽位与路径（防路径泄漏）
        deps.team.releaseSpawn(path);
        throw err;
      }
    },
  };
}

/** 给目标 agent 发消息（排队，不唤醒对方），免审批 */
function sendMessageTool(deps: CollabDeps): Tool {
  return {
    name: "send_message",
    description:
      "给指定 agent 发消息（排队投递，不唤醒对方）：目标可为相对路径（相对你自己的路径）或绝对路径（/ 开头）",
    inputSchema: z.object({
      target: z.string(),
      message: z.string(),
    }),
    isReadOnly: false,
    skipsPermission: true,
    maxResultSizeChars: 500,
    execute: async (input) => {
      const { target, message } = input as { target: string; message: string };
      if (!message.trim()) return failure("消息内容不能为空");
      const targetPath = resolveTarget(deps, target);
      if (typeof targetPath === "string") return failure(targetPath);
      const error = await deps.sendMessage(targetPath, {
        type: "MESSAGE",
        from: deps.getAgentPath() ?? AgentPath.root(),
        content: message,
        triggerTurn: false,
      });
      return error ? failure(error) : `已发送给 ${targetPath}`;
    },
  };
}

/** 给目标 agent 投递任务（投递并唤醒对方），走正常审批链 */
function followupTaskTool(deps: CollabDeps): Tool {
  return {
    name: "followup_task",
    description:
      "给指定 agent 投递新任务（投递并唤醒对方开始执行）：目标可为相对路径（相对你自己的路径）或绝对路径（/ 开头）。" +
      "消息里写明证据要求：回传执行的原始命令与关键输出片段，涉及的文件一律用绝对路径",
    inputSchema: z.object({
      target: z.string(),
      message: z.string(),
    }),
    isReadOnly: false,
    maxResultSizeChars: 500,
    execute: async (input) => {
      const { target, message } = input as { target: string; message: string };
      if (!message.trim()) return failure("任务内容不能为空");
      const targetPath = resolveTarget(deps, target);
      if (typeof targetPath === "string") return failure(targetPath);
      const error = await deps.sendMessage(targetPath, {
        type: "MESSAGE",
        from: deps.getAgentPath() ?? AgentPath.root(),
        content: message,
        triggerTurn: true,
      });
      return error ? failure(error) : `已投递任务给 ${targetPath}`;
    },
  };
}

/** 列出团队成员（含自己与尚未激活的预留成员），免审批 */
function listAgentsTool(deps: CollabDeps): Tool {
  return {
    name: "list_agents",
    description: "列出团队中的成员（层级路径，含自己与尚未激活的成员）",
    inputSchema: z.object({}),
    isReadOnly: true,
    skipsPermission: true,
    maxResultSizeChars: 2000,
    execute: () => {
      const members = deps.team.listAgents();
      if (members.length === 0) return "团队暂无其他成员";
      // 状态跟真实运行（resume 循环在跑）同步，不是「有 agent 实例就标活跃」
      return members
        .map((member) => {
          const agent = member.agent;
          const state = agent ? (agent.isActive() ? "运行中" : "空闲") : "未激活";
          return `${member.path}（${state}）`;
        })
        .join("\n");
    },
  };
}

/** 目标解析：相对当前 agent 路径（resolve 支持相对 / 绝对），非法返回错误文本 */
function resolveTarget(deps: CollabDeps, target: string): AgentPath | string {
  const current = deps.getAgentPath() ?? AgentPath.root();
  return current.resolve(target);
}

/** 挂起等待目标 agent 完成当前任务（空闲），只返回摘要不消费结论；结论由 watcher 回灌 */
function waitAgentTool(deps: CollabDeps): Tool {
  return {
    name: "wait_agent",
    description:
      "挂起等待目标 agent 完成当前任务（空闲且收件箱无消息），或超时返回；" +
      "返回区分「调用前已空闲」与「等待后完成」，目标被中断时明确告知未完成；" +
      "目标结论由完成通知自动回灌，本工具只返回等待结果",
    inputSchema: z.object({
      target: z.string(),
      timeoutMs: z.number().optional(),
    }),
    isReadOnly: false,
    maxResultSizeChars: 500,
    execute: async (input) => {
      const { target, timeoutMs } = input as { target: string; timeoutMs?: number };
      const targetPath = resolveTarget(deps, target);
      if (typeof targetPath === "string") return failure(targetPath);
      if (targetPath.toString() === (deps.getAgentPath() ?? AgentPath.root()).toString()) {
        return failure("不能等待自己");
      }
      const targetAgent = deps.team.resolveAgent(targetPath)?.agent;
      if (!targetAgent) return failure(`目标 agent ${targetPath} 不存在`);
      // 调用时的忙碌状态决定返回口径：调用前就空闲要和等待后完成分开说，
      // 模型才不会把 0ms 返回的「已完成」当成刚等完的同步完成而反复再等
      const wasBusy = targetAgent.isActive() || targetAgent.hasPendingMail();
      const startedAt = Date.now();
      while (targetAgent.isActive() || targetAgent.hasPendingMail()) {
        if (Date.now() >= startedAt + (timeoutMs ?? 30_000)) {
          return failure(`等待 ${targetPath} 超时，目标仍未完成或收件箱仍有待处理消息`);
        }
        await sleep(50);
      }
      if (targetAgent.isInterrupted()) {
        return `${targetPath} 已被中断，当前任务未完成，结论不会回灌；需要续做可用 followup_task 重新分派`;
      }
      if (!wasBusy) {
        return `${targetPath} 在本次等待前已空闲（当前任务早已结束），结论由完成通知自动回灌，无需再等待`;
      }
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      return `${targetPath} 已完成当前任务（等待 ${seconds} 秒后结束），结论由完成通知自动回灌`;
    },
  };
}

/** 中断目标 agent（turn 内）：立即中止当前模型流/工具执行；后续 followup 仍可复活 */
function interruptAgentTool(deps: CollabDeps): Tool {
  return {
    name: "interrupt_agent",
    description:
      "中断目标 agent：立即停止其当前任务（正在进行的模型生成/工具执行会中止，已产出保留）；" +
      "收件箱已有排队消息时新任务会继续处理，后续 followup_task 可让它复活",
    inputSchema: z.object({
      target: z.string(),
    }),
    isReadOnly: false,
    maxResultSizeChars: 500,
    execute: async (input) => {
      const { target } = input as { target: string };
      const targetPath = resolveTarget(deps, target);
      if (typeof targetPath === "string") return failure(targetPath);
      if (targetPath.isRoot()) return failure("root 不能被中断");
      if (targetPath.toString() === (deps.getAgentPath() ?? AgentPath.root()).toString()) {
        return failure("不能中断自己；返回结果让父 agent 处理即可");
      }
      const targetAgent = deps.team.resolveAgent(targetPath)?.agent;
      if (!targetAgent) return failure(`目标 agent ${targetPath} 不存在`);
      targetAgent.interrupt();
      return `已请求中断 ${targetPath}`;
    },
  };
}

/** 毫秒睡眠（wait_agent 轮询用） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}