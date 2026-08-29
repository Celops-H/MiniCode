/**
 * TUI 入口装配：把后端装配函数与 TUI 通道接起来——
 * 通道（approver/feedRoot/hooks）由 runTui 就绪后回调，这里用它 createSessionAgent；
 * /session 切换的会话重建循环也在此完成（装配层）。
 */
import { ensureGlobalConfigSeed, loadConfig, loadEnvFile, resolveSessionsDir } from "../config/index.js";
import { buildInstructionsPrompt, loadInstructionFiles } from "../context/index.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Session, SessionStore } from "../storage/index.js";
import { HookBus } from "../hooks/index.js";
import { PermissionPipeline, type PermissionMode, type PermissionPipelineOptions } from "../permission/index.js";
import { createBuiltinTools } from "../tools/index.js";
import { buildCompactConfig, buildHookBus, createSessionAgent, assembleSessionExtensions } from "../cli/app.js";
import { buildModelClient, NO_PROVIDER_ERROR, resolveMainModel } from "../cli/models.js";
import { Models } from "../llm/index.js";
import { NEW_SESSION_ID } from "./state.js";
import { runTui } from "./loop.js";
import type { Config } from "../config/index.js";
import type { ThinkingLevel } from "../core/index.js";

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

/** TUI 入口选项：sessionId 显式继续指定会话；continueRecent 为 -c 无参数（取最近活跃）；缺省启动草稿态 */
export interface RunTuiEntryOptions {
  /** 显式继续指定会话（minicode -c <id> / minicode tui -c <id>） */
  sessionId?: string;
  /** -c 无参数：继续最近活跃会话（listSessions 倒序首个）；无最近会话回落启动草稿态 */
  continueRecent?: boolean;
  agents?: boolean;
}

/** 初始会话解析（P6-1/2）：显式 id 加载；-c 继续最近活跃；否则构造内存草稿会话（不落盘）。
 *  启动不发消息不创建会话：草稿不带 meta 文件，第一条用户消息经 interact 轮末 flush 才写盘，
 *  启动不开会走人不在 sessions 目录留空会话。显式 id 支持短前缀——/session 面板展示 id 前 6 位
 *  （P2 审查修正：与面板展示同向，避免照抄仍匹配不上；沿用 git 式唯一前缀惯例，多敲几位可加长区分），
 *  多个会话撞前缀时取最近活跃的一个。
 *  纯函数便于层 1 测试。 */
export async function resolveInitialSession(
  options: { sessionId?: string; continueRecent?: boolean },
  store: SessionStore,
  modelId: string,
): Promise<Session> {
  const wanted = options.sessionId;
  if (wanted) {
    try {
      return await store.loadSession(wanted);
    } catch (err) {
      // 仅「文件不存在」走前缀匹配；meta 损坏等读盘错误原样上抛，不静默吞数据
      if ((err as { code?: string }).code !== "ENOENT") throw err;
      const hit = (await store.listSessions()).find((s) => s.id.startsWith(wanted));
      if (!hit) throw err;
      return await store.loadSession(hit.id);
    }
  }
  if (options.continueRecent) {
    const recent = (await store.listSessions())[0];
    if (recent) return await store.loadSession(recent.id);
  }
  const now = new Date().toISOString();
  return new Session({
    id: randomUUID(),
    title: "新会话",
    model: modelId,
    createdAt: now,
    updatedAt: now,
    formatVersion: 1,
  });
}

/** reconfigure（/connect、/model）后恢复当前会话（P6-1/S-3）：读盘成功续跑（含 /model 改过的模型）；
 *  仅「草稿未落盘」（ENOENT）重建草稿，其余读盘错误（meta 文件损坏等）上抛走装配错误路径，不静默吞数据。
 *  纯函数便于层 1 测试。 */
export async function reloadOrDraftSession(store: SessionStore, current: Session, modelId: string): Promise<Session> {
  try {
    return await store.loadSession(current.meta.id);
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
    return await resolveInitialSession({}, store, modelId);
  }
}

/** 纯草稿会话在无模型时的占位模型 id（不落盘：连接成功后 reconfigure 重建草稿） */
export const NO_MODEL_ID = "";

/**
 * 启动模型客户端装配（E31）：零可用厂商不再启动失败——返回空模型集合 + needsConnect，
 * 由 runTuiEntry 走 /connect 引导正常进入界面；其余装配错误原样上抛。
 * @param config 已加载配置（可省略，等同零厂商）
 * @returns models 模型客户端（可能为空）、modelId 主模型（无厂商时为 NO_MODEL_ID 占位）、needsConnect 是否进连接引导
 */
export function createStartupModels(config?: Config): { models: Models; modelId: string; needsConnect: boolean } {
  try {
    return { models: buildModelClient(config), modelId: resolveMainModel(config), needsConnect: false };
  } catch (err) {
    if ((err as Error).message !== NO_PROVIDER_ERROR) throw err;
    return { models: new Models(), modelId: NO_MODEL_ID, needsConnect: true };
  }
}

/** TUI 入口：新建/继续会话后进入会话循环；/session 切换与 /connect 重建在此完成（装配层） */
export async function runTuiEntry(options: RunTuiEntryOptions): Promise<void> {
  // 全局配置播种（BACKEND §14）：独立启动（dev 入口）也要装配配置前检测；
  // minicode tui 经 CLI main() 已播种，此处 wx/EEXIST 幂等
  await ensureGlobalConfigSeed();
  // .env 注入须先于 loadConfig：项目 .env 里的 MINICODE_* 配置经环境变量层进入
  // 合并链（与 CLI main 顺序一致），后加载会漏读
  await loadDotEnv();
  let config: Config = await loadConfig();
  const store = new SessionStore(config.sessionsDir ?? resolveSessionsDir());
  // 零可用厂商（E31）：正常启动进 /connect 引导；CLI 宿主非交互，保持报错退出
  const startup = createStartupModels(config);
  let models: Models = startup.models;
  let modelId: string = startup.modelId;
  let session = await resolveInitialSession(options, store, modelId);
  // 思考等级盒子跨 reconfigure 持久：/@/model 设置后切模型/换厂商不丢
  const thinkingLevelBox: { value: ThinkingLevel | undefined } = { value: undefined };
  for (;;) {
    const result = await runTuiSession(store, models, config, session, options.agents ?? true, thinkingLevelBox, startup.needsConnect);
    if (!result) break;
    // reconfigure（/connect 或 /model）重建配置链：重读 config + .env、重建模型客户端；
    // switchTo 无值时保持当前会话续跑（connect 不切会话、/model 同会话切模型）
    if (result.reconfigure) {
      // .env 先注入再读配置（同启动顺序：reconfigure 后 MINICODE_* 变量层不漏读）
      await loadDotEnv();
      config = await loadConfig();
      models = buildModelClient(config);
      modelId = resolveMainModel(config);
      // switchTo===NEW_SESSION_ID 分支实际不可达（/model 带自身 id、/connect 不带 switchTo），
      // 保留作防御（未来 reconfigure + 新建语义的兜底，整体审视 N-2）
      if (result.switchTo === NEW_SESSION_ID) {
        session = await store.createSession({ model: modelId });
      } else if (result.switchTo) {
        session = await store.loadSession(result.switchTo);
      } else {
        session = await reloadOrDraftSession(store, session, modelId);
      }
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
  thinkingLevelBox: { value: ThinkingLevel | undefined },
  startupConnect = false,
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
  // M5 扩展生态装配（BACKEND §19/§20，与 CLI 同套）：MCP server 工具 + 技能清单并入会话；
  // 启动失败的 server 已跳过，错误行 toast 一次提示、完整状态在 /mcp 面板
  const extensions = await assembleSessionExtensions(config);
  // 指令文件加载（BACKEND §21，与 CLI 同套）：用户级 + 项目侧逐级拼接进系统提示词
  const instructionsSection = buildInstructionsPrompt(await loadInstructionFiles());
  try {
    return await runTui({
      store,
      session,
      hooks,
      modelLabel: modelId,
      permissionMode: permissionModeBox,
      thinkingLevel: thinkingLevelBox,
      modelList: models.listModels().map((m) => ({ id: m.id, providerId: m.providerId, providerName: models.provider(m.providerId)?.name })),
      // 扩展面板数据源（/mcp /skill，BACKEND §19/§20）
      mcpServers: config.mcpServers ?? {},
      getMcpStatuses: () => extensions.mcpManager?.statuses() ?? [],
      skillsDisabled: config.skills?.disabled ?? [],
      startupNotices: extensions.mcpErrors,
      startupConnect,
      assemble: ({ approver, feedRoot }) => {
        const tools = [...createBuiltinTools(), ...extensions.tools];
        const systemPrompt = [SYSTEM_PROMPT, instructionsSection, extensions.promptSection]
          .filter((s) => s.length > 0)
          .join("\n");
        const pipelineOptions: PermissionPipelineOptions = {
          rules: [],
          approver,
          // plan 模式放行的只读工具集合（Tool.isReadOnly 收集；list_agents 为协作工具中的只读项，
// 只能在 Agent 内部经 deps 构造、TUI 侧显式并入，需与 collab.ts 的 isReadOnly 保持同步）
          readOnlyTools: new Set<string>([
            ...tools.filter((t) => t.isReadOnly).map((t) => t.name),
            "list_agents",
          ]),
          // mode 用 getter 活读 modeBox：Shift+Tab 切换即时作用于后续工具审批
          get mode() {
            return permissionModeBox.value;
          },
        };
        const { agent, team } = createSessionAgent({
          modelClient: models,
          modelId,
          systemPrompt,
          tools,
          initialMessages: session.getMessages(),
          agents,
          hooks,
          compactConfig,
          // 思考等级活引用：/@/model 左右调整后下一轮透传 reasoning_effort（仅支持的厂商）
          thinkingLevelRef: () => thinkingLevelBox.value,
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
        return { agent, team };
      },
    });
  } finally {
    // 会话结束（退出/切换/reconfigure 都经此）：停掉本会话的 MCP server，按进程树杀防孤儿
    extensions.mcpManager?.stopAll();
  }
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