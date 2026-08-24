#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { Agent, Team } from "../agent/index.js";
import { loadConfig, loadEnvFile, resolveSessionsDir } from "../config/index.js";
import { Logger } from "../logger/index.js";
import { SessionStore } from "../storage/index.js";
import { createBuiltinTools, killAllBackgroundTasks } from "../tools/index.js";
import type { Tool } from "../tools/index.js";
import type { Message } from "../core/index.js";
import type { ModelClient } from "../agent/index.js";
import { interact } from "./interact.js";
import { buildModelClient, resolveMainModel } from "./models.js";

const SYSTEM_PROMPT = "你是 MiniCode，一个 AI 编程助手，通过工具帮助用户完成任务。";

/** --agents 开启时追加的协调者角色定位（DESIGN 11.1；具体协作引导在 spawn_agent 工具描述里） */
const COORDINATOR_PROMPT = "你是团队协调者：可派生子 agent 并行执行任务，汇总结论后回复用户。";

export const program = new Command();
program.name("minicode").description("AI 编程 Agent 命令行工具").version("0.0.1");

program
  .command("new")
  .description("新建会话并开始对话")
  .option("-m, --model <id>", "模型 id")
  .option("--agents", "启用多 Agent 协作（模型可自主派生子 agent）")
  .action(async (options: { model?: string; agents?: boolean }) => {
    await startSession(options.model, undefined, options.agents);
  });

program
  .command("continue <sessionId>")
  .description("继续指定会话")
  .option("--agents", "启用多 Agent 协作（模型可自主派生子 agent）")
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
async function startSession(modelId?: string, sessionId?: string, agents = false): Promise<void> {
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

  const { agent } = createSessionAgent({
    modelClient: models,
    modelId: session.meta.model,
    systemPrompt: SYSTEM_PROMPT,
    tools: createBuiltinTools(),
    initialMessages: session.getMessages(),
    agents,
  });

  logger.info(`开始对话（模型 ${session.meta.model}${agents ? "，多 Agent 协作开启" : ""}）`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await interact({
    agent,
    store,
    session,
    inputs: rl,
    write: (text) => process.stdout.write(text),
  });
  rl.close();
}

/**
 * 按 agents 开关组装会话 agent（DESIGN 11.4）：
 * 开启时创建 Team 并注册 root、传入 agent（协作工具随 team 注册，模型可自主 spawn）；
 * 关闭时保持单 agent 会话（协作工具对模型不可见）。
 * 子 agent 由模型 spawn_agent 派生，继承运行时；团队不持久化（DESIGN 11），随会话结束消失。
 */
export function createSessionAgent(options: {
  modelClient: ModelClient;
  modelId: string;
  systemPrompt: string;
  tools?: Tool[];
  initialMessages?: Message[];
  agents?: boolean;
}): { agent: Agent; team?: Team } {
  if (!options.agents) {
    return { agent: new Agent(options) };
  }
  const team = new Team();
  const agent = new Agent({
    ...options,
    systemPrompt: `${options.systemPrompt}\n${COORDINATOR_PROMPT}`,
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
