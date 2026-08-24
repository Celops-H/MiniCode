/**
 * 多 Agent 协作工具（DESIGN 11.4）：spawn_agent / send_message / followup_task / list_agents。
 * 只在多 agent 环境注册（AgentOptions.team 传入时由 Agent 构造注册），普通单 agent 会话不可见。
 * 权限（DESIGN 11.4）：send_message / list_agents 免审批（skipsPermission）；
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

/** 团队工作 agent 系统提示词（DESIGN 11.6 fork_turns=none：全新上下文，无父历史） */
export const COLLAB_SUBAGENT_PROMPT =
  "你是团队工作 agent，由协调者派生执行分派的任务。你看不到协调者的完整历史，只收到任务消息。" +
  "完成任务后用简洁文字说明结论。";

export interface CollabDeps {
  team: Team;
  /** 当前 agent 在团队中的路径（未注册时返回 undefined，按 root 处理） */
  getAgentPath: () => AgentPath | undefined;
  /** 创建协作子 agent（运行时继承 + 工具集组装由 Agent 内部完成） */
  createChildAgent: (agentName: string, path: AgentPath) => Agent;
  /** 投递消息到目标 agent（Team.sendMessage，triggerTurn 时自动后台驱动） */
  sendMessage: (target: AgentPath, mail: MailMessage) => Promise<string | undefined>;
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
      "只有当任务能具体、独立成子任务且与你的本地工作并行推进时才派生，否则继续本地处理；" +
      "多个互不依赖的子任务可在同一轮并行派生，等待期间可继续做不依赖它们结果的本地工作，" +
      "需要等结果时用 wait_agent",
    inputSchema: z.object({
      agentName: z.string(),
      prompt: z.string(),
    }),
    isReadOnly: false,
    requiresUserInteraction: false,
    maxResultSizeChars: 500,
    execute: async (input) => {
      const { agentName, prompt } = input as { agentName: string; prompt: string };
      if (!prompt.trim()) return "任务内容不能为空";
      const parentPath = deps.getAgentPath() ?? AgentPath.root();
      const path = deps.team.reserveSpawn(parentPath, agentName);
      if (typeof path === "string") return path; // 守卫失败：错误文本回灌
      try {
        const child = deps.createChildAgent(agentName, path);
        deps.team.commitSpawn(path, child);
        const error = await deps.sendMessage(path, {
          type: "NEW_TASK",
          from: parentPath,
          content: prompt,
          triggerTurn: true,
        });
        if (error) return error;
        return `已派生 ${path}，初始任务已下达`;
      } catch (err) {
        // 创建/投递中途失败：释放已预留的 spawn 槽位与路径（防计数泄漏）
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
    requiresUserInteraction: false,
    skipsPermission: true,
    maxResultSizeChars: 500,
    execute: async (input) => {
      const { target, message } = input as { target: string; message: string };
      if (!message.trim()) return "消息内容不能为空";
      const targetPath = resolveTarget(deps, target);
      if (typeof targetPath === "string") return targetPath;
      const error = await deps.sendMessage(targetPath, {
        type: "MESSAGE",
        from: deps.getAgentPath() ?? AgentPath.root(),
        content: message,
        triggerTurn: false,
      });
      return error ?? `已发送给 ${targetPath}`;
    },
  };
}

/** 给目标 agent 投递任务（投递并唤醒对方），走正常审批链 */
function followupTaskTool(deps: CollabDeps): Tool {
  return {
    name: "followup_task",
    description:
      "给指定 agent 投递新任务（投递并唤醒对方开始执行）：目标可为相对路径（相对你自己的路径）或绝对路径（/ 开头）",
    inputSchema: z.object({
      target: z.string(),
      message: z.string(),
    }),
    isReadOnly: false,
    requiresUserInteraction: false,
    maxResultSizeChars: 500,
    execute: async (input) => {
      const { target, message } = input as { target: string; message: string };
      if (!message.trim()) return "任务内容不能为空";
      const targetPath = resolveTarget(deps, target);
      if (typeof targetPath === "string") return targetPath;
      const error = await deps.sendMessage(targetPath, {
        type: "MESSAGE",
        from: deps.getAgentPath() ?? AgentPath.root(),
        content: message,
        triggerTurn: true,
      });
      return error ?? `已投递任务给 ${targetPath}`;
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
    requiresUserInteraction: false,
    skipsPermission: true,
    maxResultSizeChars: 2000,
    execute: () => {
      const members = deps.team.listAgents();
      if (members.length === 0) return "团队暂无其他成员";
      return members.map((member) => `${member.path}（${member.agent ? "活跃" : "未激活"}）`).join("\n");
    },
  };
}

/** 目标解析：相对当前 agent 路径（resolve 支持相对 / 绝对），非法返回错误文本 */
function resolveTarget(deps: CollabDeps, target: string): AgentPath | string {
  const current = deps.getAgentPath() ?? AgentPath.root();
  return current.resolve(target);
}

/** 挂起等待目标 agent 完成当前任务（空闲），只返回摘要不消费结论；结论由 watcher 回灌（DESIGN 11.5） */
function waitAgentTool(deps: CollabDeps): Tool {
  return {
    name: "wait_agent",
    description:
      "挂起等待目标 agent 完成当前任务（空闲且收件箱无消息），或超时返回；" +
      "目标结论由完成通知自动回灌，本工具只返回等待结果",
    inputSchema: z.object({
      target: z.string(),
      timeoutMs: z.number().optional(),
    }),
    isReadOnly: false,
    requiresUserInteraction: false,
    maxResultSizeChars: 500,
    execute: async (input) => {
      const { target, timeoutMs } = input as { target: string; timeoutMs?: number };
      const targetPath = resolveTarget(deps, target);
      if (typeof targetPath === "string") return targetPath;
      if (targetPath.toString() === (deps.getAgentPath() ?? AgentPath.root()).toString()) {
        return "不能等待自己";
      }
      const targetAgent = deps.team.resolveAgent(targetPath)?.agent;
      if (!targetAgent) return `目标 agent ${targetPath} 不存在`;
      const deadline = Date.now() + (timeoutMs ?? 30_000);
      while (targetAgent.isActive() || targetAgent.hasPendingMail()) {
        if (Date.now() >= deadline) return `等待 ${targetPath} 超时`;
        await sleep(50);
      }
      return `${targetPath} 已完成当前任务`;
    },
  };
}

/** 中断目标 agent（turn 间）：当前 turn 结束后停止；后续 followup 仍可复活 */
function interruptAgentTool(deps: CollabDeps): Tool {
  return {
    name: "interrupt_agent",
    description:
      "中断目标 agent：停止其当前任务（当前 turn 结束后生效）；收件箱已有排队消息时新任务会继续处理，" +
      "后续 followup_task 可让它复活",
    inputSchema: z.object({
      target: z.string(),
    }),
    isReadOnly: false,
    requiresUserInteraction: false,
    maxResultSizeChars: 500,
    execute: async (input) => {
      const { target } = input as { target: string };
      const targetPath = resolveTarget(deps, target);
      if (typeof targetPath === "string") return targetPath;
      if (targetPath.isRoot()) return "root 不能被中断";
      if (targetPath.toString() === (deps.getAgentPath() ?? AgentPath.root()).toString()) {
        return "不能中断自己；返回结果让父 agent 处理即可";
      }
      const targetAgent = deps.team.resolveAgent(targetPath)?.agent;
      if (!targetAgent) return `目标 agent ${targetPath} 不存在`;
      targetAgent.interrupt();
      return `已请求中断 ${targetPath}`;
    },
  };
}

/** 毫秒睡眠（wait_agent 轮询用） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}