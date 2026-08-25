/**
 * TUI 入口装配：把后端装配函数与 TUI 通道接起来——
 * 通道（approver/feedRoot/hooks）由 runTui 就绪后回调，这里用它 createSessionAgent；
 * /session 切换的会话重建循环也在此完成（装配层）。
 */
import { loadConfig, loadEnvFile, resolveSessionsDir } from "../config/index.js";
import path from "node:path";
import { SessionStore } from "../storage/index.js";
import { HookBus } from "../hooks/index.js";
import { PermissionPipeline } from "../permission/index.js";
import { createBuiltinTools } from "../tools/index.js";
import { buildCompactConfig, buildHookBus, createSessionAgent } from "../cli/app.js";
import { buildModelClient, resolveMainModel } from "../cli/models.js";
import { NEW_SESSION_ID } from "./state.js";
import { runTui } from "./loop.js";
import type { Config } from "../config/index.js";
import type { Models } from "../llm/index.js";
import type { Session } from "../storage/index.js";

const SYSTEM_PROMPT = "你是 MiniCode，一个 AI 编程助手，通过工具帮助用户完成任务。";

/** TUI 入口：新建/继续会话后进入会话循环；/session 切换在此重建会话与 agent */
export async function runTuiEntry(options: { sessionId?: string; agents?: boolean }): Promise<void> {
  const config = await loadConfig();
  await loadDotEnv();
  const store = new SessionStore(config.sessionsDir ?? resolveSessionsDir());
  const models = buildModelClient(config);
  const modelId = resolveMainModel(config);
  let session = options.sessionId
    ? await store.loadSession(options.sessionId)
    : await store.createSession({ model: modelId });
  for (;;) {
    const result = await runTuiSession(store, models, config, session, options.agents ?? true);
    if (!result?.switchTo) break;
    session =
      result.switchTo === NEW_SESSION_ID
        ? await store.createSession({ model: modelId })
        : await store.loadSession(result.switchTo);
  }
}

/** 单个会话的 TUI 循环：装配 agent（approver 注入权限管线、feedRoot 接 onRootEvent）后跑 runTui */
async function runTuiSession(
  store: SessionStore,
  models: Models,
  config: Config,
  session: Session,
  agents: boolean,
): Promise<{ switchTo?: string } | undefined> {
  const hooks = buildHookBus(config.hooks) ?? new HookBus();
  const modelId = session.meta.model;
  return runTui({
    store,
    session,
    hooks,
    modelLabel: modelId,
    assemble: ({ approver, feedRoot }) => {
      const { agent } = createSessionAgent({
        modelClient: models,
        modelId,
        systemPrompt: SYSTEM_PROMPT,
        tools: createBuiltinTools(),
        initialMessages: session.getMessages(),
        agents,
        hooks,
        compactConfig: buildCompactConfig(config, modelId, models),
        // root 后台驱动（子 agent 完成唤醒续跑）的事件喂进 TUI reducer（双渲染流两侧都接）
        onRootEvent: feedRoot,
        // 工具权限走用户审批：approver 渲染弹块等键盘决策（允许本次/全部/拒绝）
        permission: new PermissionPipeline({ rules: [], approver }),
        // checkpoint（同 CLI）：工具副作用前把已产生消息落盘
        checkpoint: async (messages) => {
          const newOnes = messages.slice(session.getMessages().length);
          for (const message of newOnes) {
            await store.appendMessage(session, message);
          }
          await store.flush();
        },
      });
      return { agent };
    },
  });
}

/** 从 cwd/.env 加载环境变量注入 process.env（已存在不覆盖）；TUI 独立启动时保证 API key 可用 */
async function loadDotEnv(): Promise<void> {
  const vars = await loadEnvFile(path.join(process.cwd(), ".env"));
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
}

// 独立启动走 src/tui/dev.tsx（vite-node 下 import.meta.url 检测不可靠，故入口文件仅导出，由 dev 入口引导）
export {};