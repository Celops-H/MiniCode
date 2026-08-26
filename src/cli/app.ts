#!/usr/bin/env node
import { Command } from "commander";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { Agent, Team, type CompactConfig } from "../agent/index.js";
import { loadConfig, loadEnvFile, resolveSessionsDir } from "../config/index.js";
import { HookBus, createCommandHook, HOOK_EVENT_TYPES, type HookEventType } from "../hooks/index.js";
import { Logger } from "../logger/index.js";
import { SessionStore } from "../storage/index.js";
import { createBuiltinTools, killAllBackgroundTasks } from "../tools/index.js";
import type { Tool } from "../tools/index.js";
import type { Message, ThinkingLevel } from "../core/index.js";
import type { StreamEvent } from "../core/index.js";
import type { ModelClient } from "../agent/index.js";
import type { Config } from "../config/index.js";
import type { Models } from "../llm/index.js";
import { interact, renderStreamEvent } from "./interact.js";
import { buildModelClient, resolveMainModel } from "./models.js";

/** 系统提示词（与 tui/index.tsx 同文案，P2-5 打磨；CLI/TUI 共用）：终端纯文本不渲染 Markdown 是产品约定 */
const SYSTEM_PROMPT = [
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

/** 多 agent 协作开启时追加的协调者角色定位（DESIGN 11.1；具体协作引导在 spawn_agent 工具描述里） */
const COORDINATOR_PROMPT = "你是团队协调者：可派生子 agent 并行执行任务，汇总结论后回复用户。";

/** 环境信息（N3）：OS/架构/Shell/工作目录四项，供模型感知运行环境（CLI/TUI 共用，
 *  经 createSessionAgent 自动注入系统提示词）。Shell 从环境变量取，Windows 缺省记 PowerShell。 */
export function environmentPrompt(): string {
  const osName = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : process.platform;
  const shell = process.env.SHELL ?? (process.platform === "win32" ? "PowerShell" : "未知");
  return `当前环境：操作系统 ${osName}（${os.release()}），架构 ${process.arch}，Shell ${shell}，工作目录 ${process.cwd()}`;
}

export const program = new Command();
program.name("minicode").description("AI 编程 Agent 命令行工具").version("0.0.1");

program
  .command("new")
  .description("新建会话并开始对话")
  .option("-m, --model <id>", "模型 id")
  .option("--no-agents", "禁用多 Agent 协作（单 agent 会话）")
  .action(async (options: { model?: string; agents?: boolean }) => {
    await startSession(options.model, undefined, options.agents);
  });

program
  .command("continue <sessionId>")
  .description("继续指定会话")
  .option("--no-agents", "禁用多 Agent 协作（单 agent 会话）")
  .action(async (sessionId: string, options: { agents?: boolean }) => {
    await startSession(undefined, sessionId, options.agents);
  });

program
  .command("list")
  .description("列出会话")
  .action(async () => {
    const config = await loadConfig();
    const store = new SessionStore(config.sessionsDir ?? resolveSessionsDir());
    const sessions = await store.listSessions();
    if (sessions.length === 0) {
      console.log("暂无会话");
      return;
    }
    for (const meta of sessions) {
      console.log(`${meta.id}  ${meta.title}  ${meta.model}  ${meta.updatedAt}`);
    }
  });

export async function main(): Promise<void> {
  // 进程退出统一清理后台任务（DESIGN 7.5），防孤儿进程残留
  process.on("exit", () => {
    killAllBackgroundTasks();
  });
  await loadDotEnv();
  await program.parseAsync(process.argv);
}

/** 启动时从 cwd/.env 加载环境变量注入 process.env（已有变量不覆盖，见 parseEnvFile），API key 免手动 export */
async function loadDotEnv(): Promise<void> {
  const vars = await loadEnvFile(path.join(process.cwd(), ".env"));
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
}

/** 新建或继续会话，进入交互循环 */
async function startSession(modelId?: string, sessionId?: string, agents = true): Promise<void> {
  const config = await loadConfig();
  const logger = new Logger({ level: config.logLevel });
  const store = new SessionStore(config.sessionsDir ?? resolveSessionsDir());
  const models = buildModelClient(config, modelId);

  const session = sessionId
    ? await store.loadSession(sessionId)
    : await store.createSession({ model: resolveMainModel(config, modelId) });
  if (!sessionId) {
    console.log(`会话已创建：${session.meta.id}`);
  }

  const hooks = buildHookBus(config.hooks);
  const write = (text: string): void => {
    process.stdout.write(text);
  };
  const { agent, team } = createSessionAgent({
    modelClient: models,
    modelId: session.meta.model,
    systemPrompt: SYSTEM_PROMPT,
    tools: createBuiltinTools(),
    initialMessages: session.getMessages(),
    agents,
    hooks,
    compactConfig: buildCompactConfig(config, session.meta.model, models),
    // root 被后台驱动（子 agent 完成唤醒续跑）时事件转给 CLI 渲染：
    // 迟到子 agent 完成的汇总结论不打丢（review 修复），renderStreamEvent 与 interact 同渲染逻辑
    onRootEvent: (event) => renderStreamEvent(write, event),
    // checkpoint（DESIGN 14）：工具执行前把已产生的消息落盘——
    // 以 session 内存消息数为游标（appendMessage 同步 append 到内存），只入队未落盘部分
    checkpoint: async (messages) => {
      const newOnes = messages.slice(session.getMessages().length);
      for (const message of newOnes) {
        await store.appendMessage(session, message);
      }
      await store.flush();
    },
  });

  logger.info(`开始对话（模型 ${session.meta.model}${agents ? "，多 Agent 协作开启" : ""}）`);
  // 会话开始（DESIGN 13.3：会话级事件由宿主触发）
  await hooks?.emit({ type: "SessionStart" });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await interact({
      agent,
      store,
      session,
      inputs: rl,
      write,
      hooks,
    });
  } finally {
    // 会话结束（DESIGN 13.3：会话级事件由宿主触发）；
    // try/finally 兜底：interact 内抛错（如模型流错误）也要触发 SessionEnd，观测事件不缺失
    await hooks?.emit({ type: "SessionEnd" });
    // 会话收尾清理团队：中断活跃子 agent、清空注册表（防后台 resume 循环吊住进程、成员残留）
    team?.clear();
  }
  rl.close();
}

/**
 * 按 config.hooks 装配 Hook 总线（DESIGN 13）：每条命令包装成对应事件的处理器；
 * 未配置 hooks 时返回 undefined（Hook 系统不启用）。
 */
export function buildHookBus(hooks?: Config["hooks"]): HookBus | undefined {
  if (!hooks) return undefined;
  const bus = new HookBus();
  for (const eventType of HOOK_EVENT_TYPES) {
    for (const command of hooks[eventType] ?? []) {
      bus.on(eventType, createCommandHook(command));
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

/**
 * 按 agents 开关组装会话 agent（DESIGN 11.4，默认开启）：
 * 开启时创建 Team 并注册 root、传入 agent（协作工具随 team 注册，模型可自主 spawn）；
 * 显式传 false 时保持单 agent 会话（协作工具对模型不可见）。
 * 子 agent 由模型 spawn_agent 派生，继承运行时；团队不持久化（DESIGN 11），随会话结束消失。
 */
export function createSessionAgent(options: {
  modelClient: ModelClient;
  modelId: string;
  systemPrompt: string;
  tools?: Tool[];
  initialMessages?: Message[];
  agents?: boolean;
  hooks?: HookBus;
  compactConfig?: CompactConfig;
  checkpoint?: (messages: Message[]) => Promise<void> | void;
  /** 思考等级活引用（/@/model 左右调整实时生效）：每轮读一次透传 reasoning_effort（仅支持的厂商） */
  thinkingLevelRef?: () => ThinkingLevel | undefined;
  /** root 被后台驱动（子 agent 完成唤醒续跑）时的事件转发（CLI 渲染 root 迟到结论） */
  onRootEvent?: (event: StreamEvent) => void;
}): { agent: Agent; team?: Team } {
  const envPrompt = environmentPrompt();
  if (options.agents === false) {
    return { agent: new Agent({ ...options, systemPrompt: `${options.systemPrompt}\n${envPrompt}` }) };
  }
  const team = new Team({ onRootEvent: options.onRootEvent, hooks: options.hooks });
  const agent = new Agent({
    ...options,
    systemPrompt: `${options.systemPrompt}\n${COORDINATOR_PROMPT}\n${envPrompt}`,
    team,
  });
  team.registerRoot(agent);
  return { agent, team };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`启动失败：${(err as Error).message}`);
    process.exit(1);
  });
}
