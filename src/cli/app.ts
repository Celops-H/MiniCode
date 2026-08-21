import { Command } from "commander";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { Agent } from "../agent/index.js";
import { loadConfig } from "../config/index.js";
import { Logger } from "../logger/index.js";
import { SessionStore } from "../storage/index.js";
import { createBuiltinTools } from "../tools/index.js";
import { interact } from "./interact.js";
import { buildModelClient, resolveMainModel } from "./models.js";

const SYSTEM_PROMPT = "你是 MiniCode，一个 AI 编程助手，通过工具帮助用户完成任务。";
const SESSIONS_DIR = ".sessions";

export const program = new Command();
program.name("minicode").description("AI 编程 Agent 命令行工具").version("0.0.1");

program
  .command("new")
  .description("新建会话并开始对话")
  .option("-m, --model <id>", "模型 id")
  .action(async (options: { model?: string }) => {
    await startSession(options.model);
  });

program
  .command("continue <sessionId>")
  .description("继续指定会话")
  .action(async (sessionId: string) => {
    await startSession(undefined, sessionId);
  });

program
  .command("list")
  .description("列出会话")
  .action(async () => {
    const store = new SessionStore(SESSIONS_DIR);
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
  await program.parseAsync(process.argv);
}

/** 新建或继续会话，进入交互循环 */
async function startSession(modelId?: string, sessionId?: string): Promise<void> {
  const config = await loadConfig();
  const logger = new Logger({ level: config.logLevel });
  const store = new SessionStore(SESSIONS_DIR);
  const models = buildModelClient(config, modelId);

  const session = sessionId
    ? await store.loadSession(sessionId)
    : await store.createSession({ model: resolveMainModel(config, modelId) });
  if (!sessionId) {
    console.log(`会话已创建：${session.meta.id}`);
  }

  const agent = new Agent({
    modelClient: models,
    modelId: session.meta.model,
    systemPrompt: SYSTEM_PROMPT,
    tools: createBuiltinTools(),
    initialMessages: session.getMessages(),
  });

  logger.info(`开始对话（模型 ${session.meta.model}）`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`启动失败：${(err as Error).message}`);
    process.exit(1);
  });
}
