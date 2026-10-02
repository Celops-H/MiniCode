/**
 * 会话装配层：TUI 与入口共用的装配函数——系统提示词、会话扩展生态（MCP/技能）、
 * 流水日志、Hook 总线、压缩配置与会话 agent 都在这里组装，宿主只做通道注入。
 */
import path from "node:path";
import { Agent, Team, type CompactConfig } from "../agent/index.js";
import type { ModelClient } from "../agent/index.js";
import { resolveLogsDir } from "../config/index.js";
import type { Config } from "../config/index.js";
import { environmentPrompt } from "../context/index.js";
import { HookBus, createCommandHook, HOOK_EVENT_TYPES, type HookEvent, type HookEventType } from "../hooks/index.js";
import { Logger } from "../logger/index.js";
import { McpManager } from "../mcp/index.js";
import { buildSkillsPromptSection, createSkillTool, scanSkills } from "../skills/index.js";
import type { Tool } from "../tools/index.js";
import type { Message, ThinkingLevel, StreamEvent } from "../core/index.js";
import type { PermissionPipeline } from "../permission/index.js";
import type { Models } from "../llm/index.js";

/** 系统提示词（单一出处，TUI 侧从本模块引用）：终端纯文本不渲染 Markdown 是产品约定 */
export const SYSTEM_PROMPT = [
  "你是 MiniCode，一个运行在命令行终端的 AI 编程助手，通过工具帮用户完成软件工程任务。",
  "",
  "【回复风格：终端是纯文本，不渲染 Markdown】",
  "1. 回复一律用纯文本，不要用任何 Markdown 符号：不加粗、不用星号、不加反引号、不用井号标题、不用引用符号、不用分隔线、不用破折号列表。文件名、代码路径、命令原文直接写，不加任何装饰。",
  "2. 需要分点就用「第 1 点、第 2 点」或自然段，不要用符号列表。",
  "3. 结论先行：先给结论或答案，再补必要说明。不寒暄、不客套、不重复用户的话。默认中文（用户换语言则跟随）。",
  "",
  "【工作方式】",
  "4. 动手前先查证：读文件、搜索代码、看目录结构，不要凭记忆编造文件内容、目录结构或命令结果。",
  "5. 能直接改就直接改；每次改动后告诉用户怎么验证（跑什么命令）。",
  "6. 只做用户要求的事；超出范围的想法先说明再确认。",
  "7. 任务收尾简短总结：做了什么、结果如何、下一步建议。",
  "",
  "【多 Agent 协作】",
  "8. 复杂任务可拆子任务并行派给子 agent；等结论齐全后汇总成一份完整回复，不要只汇报「已派发」。",
  "",
  "【约束】",
  "9. 破坏性操作（删除/覆盖/强制提交等）先征得用户同意；不外泄密钥/隐私。",
].join("\n");

/** 多 agent 协作开启时追加的协调者角色定位（具体协作引导在 spawn_agent 工具描述里） */
const COORDINATOR_PROMPT = "你是团队协调者：可派生子 agent 并行执行任务，汇总结论后回复用户。";

/** 项目版本号（轨迹 header、--version 用；与 package.json version 保持同步） */
export const MINICODE_VERSION = "0.0.1";

/** 会话扩展生态装配结果：需并入会话的工具与系统提示词段落 */
export interface SessionExtensions {
  /** 追加到内置工具之后的工具（MCP 工具 + skill 工具） */
  tools: Tool[];
  /** 追加到主系统提示词之后的段落（技能清单）；空串表示无 */
  promptSection: string;
  /** MCP 管理器：会话结束调用 stopAll 按进程树杀 server 防孤儿进程；未配置 MCP 时为 null */
  mcpManager: McpManager | null;
  /** MCP 启动失败错误行（宿主输出给用户；失败的 server 已跳过） */
  mcpErrors: string[];
}

/**
 * 会话扩展生态装配：启动全部已启用 MCP server（失败的跳过
 * 并记录错误行，不阻断会话）、扫描技能目录；技能非空时产出 skill 工具与「可用技能」提示词段
 * （工具与提示词同进退）。
 * @param config 已加载配置（取 mcpServers 与 skills.disabled）
 * @param opts 技能目录覆盖（测试注入；缺省项目 <cwd>/.minicode/skills、用户 ~/.minicode/skills）；
 *   logger 传入时记录 MCP 启动摘要、连接断开与技能加载
 */
export async function assembleSessionExtensions(
  config: Pick<Config, "mcpServers" | "skills">,
  opts: { projectSkillsDir?: string; userSkillsDir?: string; logger?: Logger } = {},
): Promise<SessionExtensions> {
  const tools: Tool[] = [];
  let promptSection = "";
  let mcpManager: McpManager | null = null;
  let mcpErrors: string[] = [];
  const logger = opts.logger;

  const servers = config.mcpServers ?? {};
  if (Object.keys(servers).length > 0) {
    mcpManager = new McpManager(servers, {
      onDisconnect: (name, reason) => logger?.warn(`MCP 服务 ${name} 连接断开：${reason}`),
    });
    tools.push(...(await mcpManager.startAll()));
    mcpErrors = mcpManager.errors();
    const failed = mcpManager.statuses().filter((s) => s.enabled && s.error).length;
    logger?.info(`MCP 服务启动：${mcpManager.statuses().filter((s) => s.started).length} 个成功，${failed} 个失败`);
    for (const line of mcpErrors) logger?.warn(line);
  }

  const skills = await scanSkills({
    projectDir: opts.projectSkillsDir,
    userDir: opts.userSkillsDir,
    disabled: config.skills?.disabled,
  });
  if (skills.length > 0) {
    tools.push(createSkillTool(skills));
    promptSection = buildSkillsPromptSection(skills);
    logger?.info(`技能加载：${skills.length} 个`);
  }

  return { tools, promptSection, mcpManager, mcpErrors };
}

/**
 * 流水日志文件 Logger：级别走 logLevel 配置
 * （MINICODE_LOG_LEVEL 环境变量经配置加载层可覆盖），写 ~/.minicode/logs/minicode.log，
 * 单文件超限轮转保留 .old 一份。日志无新增配置项。
 * @param config 已加载配置（取 logLevel）
 * @returns 只写文件的 Logger
 */
export function createFileLogger(config: Pick<Config, "logLevel">): Logger {
  return new Logger({
    level: config.logLevel,
    file: { path: path.join(resolveLogsDir(), "minicode.log") },
  });
}

/**
 * 按 config.hooks 装配 Hook 总线：每条命令包装成对应事件的处理器；
 * 未配置 hooks 时返回 undefined（Hook 系统不启用）。
 * @param hooks hook 配置
 * @param opts.onStderr hook 命令 stderr 的观测输出通道：TUI 宿主注入界面通道
 *   （全屏渲染下直写 stderr 会插花渲染帧）；缺省直写本进程 stderr
 * @param opts.onHandlerError 处理器异常回调：宿主接流水日志
 */
export function buildHookBus(
  hooks?: Config["hooks"],
  opts: { onStderr?: (text: string) => void; onHandlerError?: (error: unknown, event: HookEvent) => void } = {},
): HookBus | undefined {
  if (!hooks) return undefined;
  const bus = new HookBus({ onHandlerError: opts.onHandlerError });
  for (const eventType of HOOK_EVENT_TYPES) {
    for (const command of hooks[eventType] ?? []) {
      bus.on(eventType, createCommandHook(command, { onStderr: opts.onStderr }));
    }
  }
  return bus;
}

/**
 * 按 config.compact 装配压缩配置：contextWindow 缺省取模型定义值（再缺省 128000）。
 * 未配置 compact 时返回 undefined（压缩不启用）。
 */
export function buildCompactConfig(
  config: Config | undefined,
  modelId: string,
  models?: Models,
): CompactConfig | undefined {
  const compact = config?.compact;
  if (!compact) return undefined;
  const model = models?.resolve(modelId)?.model;
  return {
    contextWindow: compact.contextWindow ?? model?.contextWindow ?? 128_000,
    // 其余三项 schema 已 default（8192/4096/5），这里再兜底：非 zod 解析路径（测试/手拼 config）缺省时不 undefined
    maxOutputTokens: compact.maxOutputTokens ?? 8192,
    safetyMargin: compact.safetyMargin ?? 4096,
    keepRecentToolResults: compact.keepRecentToolResults ?? 5,
  };
}

/** 多 agent 协作生效判定：CLI 旗标（--no-agents）与 config.agents 合取，任一显式关闭即单 agent 会话 */
export function resolveAgentsEnabled(flag: boolean | undefined, configAgents: boolean | undefined): boolean {
  return flag !== false && configAgents !== false;
}

/**
 * 按 agents 开关组装会话 agent（默认开启）：
 * 开启时创建 Team 并注册 root、传入 agent（协作工具随 team 注册，模型可自主 spawn）；
 * 显式传 false 时保持单 agent 会话（协作工具对模型不可见）。
 * 子 agent 由模型 spawn_agent 派生，继承运行时；团队不持久化，随会话结束消失。
 */
export function createSessionAgent(options: {
  modelClient: ModelClient;
  modelId: string;
  systemPrompt: string;
  tools?: Tool[];
  initialMessages?: Message[];
  agents?: boolean;
  /** 撞线自动压缩开关（缺省开；透传给 Agent） */
  autoCompact?: boolean;
  /** 子 agent git worktree 隔离缺省开关（缺省关；透传给 Team，
   *  生产装配从 config.worktrees 取值——派生时 spawn_agent 的 worktree 参数缺省随它） */
  worktrees?: boolean;
  hooks?: HookBus;
  compactConfig?: CompactConfig;
  checkpoint?: (messages: Message[]) => Promise<void> | void;
  /** 思考等级活引用（/model 左右调整实时生效）：每轮读一次透传 reasoning_effort（仅支持的厂商） */
  thinkingLevelRef?: () => ThinkingLevel | undefined;
  /** root 被后台驱动（子 agent 完成唤醒续跑）时的事件转发（渲染 root 迟到结论） */
  onRootEvent?: (event: StreamEvent) => void;
  /** 权限管线（TUI 注入用户审批 approver）；缺省不启用 */
  permission?: PermissionPipeline;
  /** 协作子 agent 的提示词附加段（项目指令段 + 可用技能段，装配时传入；
   *  派生时拼在协作提示之后、环境段之前，子 agent 与 root 同守项目约定） */
  subagentPromptSections?: string[];
}): { agent: Agent; team?: Team } {
  const envPrompt = environmentPrompt();
  if (options.agents === false) {
    return { agent: new Agent({ ...options, systemPrompt: `${options.systemPrompt}\n${envPrompt}` }) };
  }
  const team = new Team({ onRootEvent: options.onRootEvent, hooks: options.hooks, worktrees: options.worktrees });
  const agent = new Agent({
    ...options,
    systemPrompt: `${options.systemPrompt}\n${COORDINATOR_PROMPT}\n${envPrompt}`,
    team,
  });
  team.registerRoot(agent);
  return { agent, team };
}
