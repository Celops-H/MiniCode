/**
 * TUI 入口装配：把后端装配函数与 TUI 通道接起来——
 * 通道（approver/feedRoot/hooks）由 runTui 就绪后回调，这里用它 createSessionAgent；
 * /session 切换的会话重建循环也在此完成（装配层）。
 */
import { loadConfig, loadEnvFile, resolveSessionsDir } from "../config/index.js";
import path from "node:path";
import { SessionStore } from "../storage/index.js";
import { HookBus } from "../hooks/index.js";
import { PermissionPipeline, type PermissionMode, type PermissionPipelineOptions } from "../permission/index.js";
import { createBuiltinTools } from "../tools/index.js";
import { buildCompactConfig, buildHookBus, createSessionAgent } from "../cli/app.js";
import { buildModelClient, resolveMainModel } from "../cli/models.js";
import { NEW_SESSION_ID } from "./state.js";
import { runTui } from "./loop.js";
import type { Config } from "../config/index.js";
import type { Models } from "../llm/index.js";
import type { Session } from "../storage/index.js";

/**
 * 系统提示词（对齐主流 agent CLI 的写法，2026-08-26 打磨）：
 * - 核心诉求：终端是纯文本、不渲染 Markdown——明确禁止回复里出现 markdown 符号（历史反馈
 *   「**编写代码**：xxx」乱码的根因）；其余要点照搬主流 agent（opencode/Claude Code）的基调：
 *   简洁结论先行、少寒暄、工具先查证不编造、只做被要求的事、多 agent 汇总结论。
 * - 与 cli/app.ts 的 SYSTEM_PROMPT 保持一致（两处同文案，分别属于 tui/main 分支）。
 */
export const SYSTEM_PROMPT = [
  "你是 MiniCode，一个运行在命令行终端的 AI 编程助手，通过工具帮用户完成软件工程任务。",
  "",
  "【回复风格：终端是纯文本，不渲染 Markdown】",
  "1. 回复一律用纯文本，不要用任何 Markdown 符号：不加粗、不用星号、不加反引号、不用井号标题、不用引用符号、不用分隔线、不用破折号列表。文件名、代码路径、命令原文直接写，不加任何装饰。",
  "2. 需要分点就用「第 1 点、第 2 点」或自然段，不要用符号列表。",
  "3. 结论先行：先给结论或答案，再补必要说明。不寒暄、不客套、不重复用户的话。",
  "",
  "【工作方式】",
  "4. 动手前先查证：读文件、搜索代码、看目录结构，不要凭记忆编造文件内容、目录结构或命令结果。",
  "5. 能直接改就直接改；每次改动后告诉用户怎么验证（跑什么命令）。",
  "6. 只做用户要求的事；超出范围的想法先说明再确认。",
  "7. 任务收尾简短总结：做了什么、结果如何、下一步建议。",
  "",
  "【多 Agent 协作】",
  "8. 复杂任务可拆子任务并行派给子 agent；等结论齐全后汇总成一份完整回复，不要只汇报「已派发」",
].join("\n");

/** TUI 入口：新建/继续会话后进入会话循环；/session 切换与 /connect 重建在此完成（装配层） */
export async function runTuiEntry(options: { sessionId?: string; agents?: boolean }): Promise<void> {
  let config: Config = await loadConfig();
  await loadDotEnv();
  const store = new SessionStore(config.sessionsDir ?? resolveSessionsDir());
  let models: Models = buildModelClient(config);
  let modelId: string = resolveMainModel(config);
  let session = options.sessionId
    ? await store.loadSession(options.sessionId)
    : await store.createSession({ model: modelId });
  for (;;) {
    const result = await runTuiSession(store, models, config, session, options.agents ?? true);
    if (!result) break;
    // /connect 成功后重建配置链：重读 config + .env，重建模型客户端与主模型（新会话落新模型）
    if (result.reconfigure) {
      config = await loadConfig();
      await loadDotEnv();
      models = buildModelClient(config);
      modelId = resolveMainModel(config);
      session =
        result.switchTo === NEW_SESSION_ID
          ? await store.createSession({ model: modelId })
          : await store.loadSession(result.switchTo ?? session.meta.id);
      continue;
    }
    if (!result.switchTo) break;
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
): Promise<{ switchTo?: string; reconfigure?: boolean } | undefined> {
  const hooks = buildHookBus(config.hooks) ?? new HookBus();
  const modelId = session.meta.model;
  // /compact 开箱可用：config.compact 未配置时给默认压缩配置（对齐 schema 缺省值），
  // 否则 compactNow 直接返回 false 提示「未配置压缩」（后端 buildCompactConfig 的兜底在 main 同步）
  const compactConfig = buildCompactConfig(config, modelId, models) ?? {
    contextWindow: models?.resolve(modelId)?.model?.contextWindow ?? 128_000,
    maxOutputTokens: 8192,
    safetyMargin: 4096,
    keepRecentToolResults: 5,
  };
  // 权限模式盒子：Shift+Tab 在 loop 侧改这里，PermissionPipeline 经 options.mode getter 活读（plan/auto 即时生效）
  const permissionModeBox: { value: PermissionMode } = { value: "default" };
  return runTui({
    store,
    session,
    hooks,
    modelLabel: modelId,
    permissionMode: permissionModeBox,
    assemble: ({ approver, feedRoot }) => {
      const tools = createBuiltinTools();
      const pipelineOptions: PermissionPipelineOptions = {
        rules: [],
        approver,
        // plan 模式放行的只读工具集合（Tool.isReadOnly 收集）
        readOnlyTools: new Set(tools.filter((t) => t.isReadOnly).map((t) => t.name)),
        // mode 用 getter 活读 modeBox：Shift+Tab 切换即时作用于后续工具审批
        get mode() {
          return permissionModeBox.value;
        },
      };
      const { agent } = createSessionAgent({
        modelClient: models,
        modelId,
        systemPrompt: SYSTEM_PROMPT,
        tools,
        initialMessages: session.getMessages(),
        agents,
        hooks,
        compactConfig,
        // root 后台驱动（子 agent 完成唤醒续跑）的事件喂进 TUI reducer（双渲染流两侧都接）
        onRootEvent: feedRoot,
        // 工具权限走用户审批：approver 渲染弹块等键盘决策（允许本次/全部/拒绝）
        permission: new PermissionPipeline(pipelineOptions),
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