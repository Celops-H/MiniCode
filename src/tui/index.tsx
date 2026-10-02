/**
 * TUI 入口装配：把后端装配函数与 TUI 通道接起来——
 * 通道（approver/feedRoot/hooks）由 runTui 就绪后回调，这里用它 createSessionAgent；
 * /session 切换的会话重建循环也在此完成（装配层）。
 */
import { ensureGlobalConfigSeed, loadConfig, loadEnvFile, resolveSessionsDir, resolveSessionsRoot, resolveTracesDir } from "../config/index.js";
import { buildInstructionsPrompt, loadInstructionFiles } from "../context/index.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Session, SessionStore } from "../storage/index.js";
import { HookBus, type HookEvent } from "../hooks/index.js";
import { PermissionPipeline, type PermissionMode, type PermissionPipelineOptions } from "../permission/index.js";
import { createBuiltinTools } from "../tools/index.js";
import {
  SYSTEM_PROMPT,
  assembleSessionExtensions,
  buildCompactConfig,
  buildHookBus,
  createFileLogger,
  createSessionAgent,
  resolveAgentsEnabled,
  MINICODE_VERSION,
} from "../bootstrap/assemble.js";
import { attachRecorder, deleteTrace } from "../observability/index.js";
import { attachHookLogging, hookHandlerErrorText } from "../logger/index.js";
import { buildModelClient, NO_PROVIDER_ERROR, resolveMainModel } from "../bootstrap/models.js";
import { Models } from "../llm/index.js";
import { NEW_SESSION_ID, initState } from "./state.js";
import { rebuildUsageFromTrace, usageFromMessages } from "./usage.js";
import { createStore } from "solid-js/store";

import { type SetStoreFunction } from "solid-js/store";
import type { TuiState } from "./state.js";
import { createTuiTerminal, runTui, type TuiSharedMount, type TuiTerminal } from "./loop.js";
import type { Config } from "../config/index.js";
import type { ThinkingLevel } from "../core/index.js";

/**
 * 系统提示词（单一出处与完整说明见 src/bootstrap/assemble.ts）：
 * 终端是纯文本、不渲染 Markdown 是产品约定；这里 re-export 供 TUI 侧既有引用继续使用。
 */
export { SYSTEM_PROMPT };

/** TUI 入口选项：sessionId 显式继续指定会话；continueRecent 为 -c 无参数（取最近活跃）；缺省启动草稿态 */
export interface RunTuiEntryOptions {
  /** 显式继续指定会话（minicode -c <id> / minicode tui -c <id>） */
  sessionId?: string;
  /** -c 无参数：继续最近活跃会话（listSessions 倒序首个）；无最近会话回落启动草稿态 */
  continueRecent?: boolean;
  agents?: boolean;
  /** 项目根 AGENTS.md 路径（/init 免审批判定与生成目标；缺省 <cwd>/AGENTS.md） */
  projectAgentsFile?: string;
}

/** 初始会话解析：显式 id 加载；-c 继续最近活跃；否则构造内存草稿会话（不落盘）。
 *  启动不发消息不创建会话：草稿不带 meta 文件，第一条用户消息经 interact 轮末 flush 才写盘，
 *  启动不开会走人不在 sessions 目录留空会话。显式 id 支持短前缀——/session 面板展示 id 前 6 位
 *  （与面板展示同向，避免照抄仍匹配不上；沿用 git 式唯一前缀惯例，多敲几位可加长区分），
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

/** reconfigure（/connect、/model）后恢复当前会话：读盘成功续跑（含 /model 改过的模型）；
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
 * 启动模型客户端装配：零可用厂商不再启动失败——返回空模型集合 + needsConnect，
 * 由 runTuiEntry 走 /connect 引导正常进入界面；其余装配错误原样上抛。
 * modelChain 死条目等装配告警收集返回，由 runTuiEntry 转界面提示（不 console 直写花屏）。
 * @param config 已加载配置（可省略，等同零厂商）
 * @returns models 模型客户端（可能为空）、modelId 主模型（无厂商时为 NO_MODEL_ID 占位）、
 *   needsConnect 是否进连接引导、warnings 装配告警列表
 */
export function createStartupModels(config?: Config): {
  models: Models;
  modelId: string;
  needsConnect: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  try {
    return {
      models: buildModelClient(config, undefined, { onWarning: (w) => warnings.push(w) }),
      modelId: resolveMainModel(config),
      needsConnect: false,
      warnings,
    };
  } catch (err) {
    if ((err as Error).message !== NO_PROVIDER_ERROR) throw err;
    return { models: new Models(), modelId: NO_MODEL_ID, needsConnect: true, warnings };
  }
}

/** TUI 入口：新建/继续会话后进入会话循环；/session 切换与 /connect 重建在此完成（装配层） */
export async function runTuiEntry(options: RunTuiEntryOptions): Promise<void> {
  // 全局配置播种：独立启动（dev 入口）也要装配配置前检测；
  // minicode tui 经 CLI main() 已播种，此处 wx/EEXIST 幂等
  await ensureGlobalConfigSeed();
  // .env 注入须先于 loadConfig：项目 .env 里的 MINICODE_* 配置经环境变量层进入
  // 合并链（与 CLI main 顺序一致），后加载会漏读
  await loadDotEnv();
  let config: Config = await loadConfig();
  // 会话按启动工作目录隔离存储：各目录只看自己的会话
  const store = new SessionStore(resolveSessionsDir({ cwd: process.cwd(), root: config.sessionsDir }));
  // 零可用厂商：正常启动进 /connect 引导；CLI 宿主非交互，保持报错退出
  const startup = createStartupModels(config);
  let models: Models = startup.models;
  let modelId: string = startup.modelId;
  // 装配告警（modelChain 死条目等）：每个会话轮经 startupNotices 提示一次，
  // reconfigure 重建模型客户端时重置重收
  let modelWarnings: string[] = startup.warnings;
  let session = await resolveInitialSession(options, store, modelId);
  // 思考等级盒子跨 reconfigure 持久：/model 设置后切模型/换厂商不丢
  const thinkingLevelBox: { value: ThinkingLevel | undefined } = { value: undefined };
  // 权限模式盒子上提到入口层：carry 续接的 UI 权限模式与管线实际值一致
  const permissionModeBox: { value: PermissionMode } = { value: "default" };
  // 共享终端一次创建跨会话复用（reconfigure 不再销毁重建渲染器——闪屏根源）
  const terminal = await createTuiTerminal();
  // 共享挂载：Solid 根只挂一次——同一渲染器重复 render 会叠加旧根
  //（旧树 useKeyboard 不卸载，按键双份处理）；会话轮换仅重置 store 内容并切换动作分发
  const [sharedState, setSharedState] = createStore<TuiState>(initState(session.getMessages(), session.meta.title, modelId));
  const shared: TuiSharedMount = { state: sharedState, setState: setSharedState, mounted: false };
  // 共享模式下视图内容是否按当前会话重建：首轮/切会话/新建草稿 true，reconfigure carry 续接 false
  let resetView = true;
  // 启动引导只作用于首轮：连接成功的 reconfigure 后不复位会复弹弹窗
  let firstRound = true;
  try {
    for (;;) {
      const result = await runTuiSession({
        store,
        models,
        config,
        session,
        // 多 Agent 协作生效判定：CLI 旗标（--no-agents）与 config.agents 合取；
        // config 随 reconfigure 重读，协作开关改配置后重装配即生效
        agents: resolveAgentsEnabled(options.agents, config.agents),
        thinkingLevelBox,
        permissionModeBox,
        startupConnect: startup.needsConnect && firstRound,
        modelWarnings,
        shared,
        resetView,
        terminal,
        projectAgentsFile: options.projectAgentsFile,
      });
      firstRound = false;
      if (result.reconfigure) {
        // 轮换前清瞬时态：连接成功的 connect-key 弹窗残留（再按 Enter 会重复触发连接）必须清；
        // toast 不清——carry 续接保留界面内容，新轮 runTui 会给遗留 toast 重新挂过期定时器，
        // 成功提示（模型已切换/已连接/配置已写入）正常显示、到期自然消失
        setSharedState({ modal: undefined });
        // reconfigure（/connect 或 /model）原位重建配置链：重读 config + .env、重建模型客户端；
        // 会话内视图不按盘上消息重建（store 内容原样续接，历史固定）；切会话/新建草稿才重建视图。
        // 装配告警随重建重置重收
        await loadDotEnv();
        config = await loadConfig();
        modelWarnings = [];
        models = buildModelClient(config, undefined, { onWarning: (w) => modelWarnings.push(w) });
        modelId = resolveMainModel(config);
        // switchTo===NEW_SESSION_ID 分支实际不可达（reconfigure 不带 switchTo），保留作防御
        if (result.switchTo === NEW_SESSION_ID) {
          session = await store.createSession({ model: modelId });
          resetView = true;
        } else if (result.switchTo) {
          session = await store.loadSession(result.switchTo);
          resetView = true;
        } else {
          session = await reloadOrDraftSession(store, session, modelId);
          // 引导态先发消息后连接：草稿可能以空模型落盘，
          // 载入的会话模型在新配置里不可解析时归位为当前主模型，免得已连接仍报「未知模型」；
          // 内存归位即可，下一轮落盘自然纠正盘上 meta
          if (!session.meta.model || !models.resolve(session.meta.model)) {
            session.meta.model = modelId;
          }
          resetView = false;
        }
        continue;
      }
      if (!result.switchTo) break;
      // /session 切换：视图按新会话消息重建
      session =
        result.switchTo === NEW_SESSION_ID
          ? await store.createSession({ model: modelId })
          : await store.loadSession(result.switchTo);
      resetView = true;
    }
  } finally {
    terminal.dispose();
  }
}

/** 单个会话的 TUI 循环参数：装配 agent（approver 注入权限管线、feedRoot 接 onRootEvent）后跑 runTui */
async function runTuiSession(opts: {
  store: SessionStore;
  models: Models;
  config: Config;
  session: Session;
  agents: boolean;
  thinkingLevelBox: { value: ThinkingLevel | undefined };
  /** 权限模式盒子（入口层持有，跨会话持久，与 carry 续接的 UI 一致） */
  permissionModeBox: { value: PermissionMode };
  /** 零可用厂商启动引导（仅首轮可能为 true） */
  startupConnect?: boolean;
  /** 装配告警（modelChain 死条目等），随启动提示一并 toast */
  modelWarnings?: string[];
  /** 共享挂载上下文（入口层创建一次） */
  shared: TuiSharedMount;
  /** 本轮是否按当前会话重建视图内容（false = carry 续接） */
  resetView: boolean;
  /** 共享终端（入口层创建一次） */
  terminal?: TuiTerminal;
  /** 项目根 AGENTS.md 路径（/init 免审批判定与生成目标；缺省 <cwd>/AGENTS.md） */
  projectAgentsFile?: string;
}): Promise<{ switchTo?: string; reconfigure?: boolean; state: TuiState }> {
  const { store, models, config, session, agents, thinkingLevelBox, permissionModeBox } = opts;
  // hook stderr 通道：可变盒子由 runTui 挂载后指向 toast，hook 观测输出不直写
  // stderr（全屏渲染下会以裸文本插进渲染帧）。盒子指向 toast 前的窗口期输出静默丢弃
  // （当前装配顺序下无事件落在该窗口；若调整装配顺序需留意）
  const hookStderrBox: { value?: (text: string) => void } = {};
  // 流水日志：文件 Logger（TUI 全屏渲染，不走控制台输出）
  const logger = createFileLogger(config);
  const onHandlerError = (err: unknown, event: HookEvent): void => logger.error(hookHandlerErrorText(err, event));
  const hooks =
    buildHookBus(config.hooks, { onStderr: (text) => hookStderrBox.value?.(text), onHandlerError }) ??
    new HookBus({ onHandlerError });
  const modelId = session.meta.model;
  logger.info(`启动：minicode ${MINICODE_VERSION}（cwd ${process.cwd()}）`);
  logger.info(`配置加载完成（logLevel ${config.logLevel}）`);
  logger.info(`会话 ${session.meta.id}（模型 ${session.meta.model}）开始`);
  // 可观测性装配（与 CLI 同套）：Recorder 订阅总线写轨迹；
  // enabled=false 时不装配。轨迹目录同时供 /session 删除联动（先轨迹后会话）使用
  const tracesDir = config.observability?.dir ?? resolveTracesDir();
  attachRecorder(hooks, {
    sessionId: session.meta.id,
    cwd: process.cwd(),
    minicodeVersion: MINICODE_VERSION,
    sessionsRoot: resolveSessionsRoot({ root: config.sessionsDir }),
    enabled: config.observability?.enabled,
    dir: config.observability?.dir,
  });
  // 流水日志埋点：模型请求/fallback/压缩/工具失败/权限拒绝随事件入日志
  attachHookLogging(hooks, logger);
  // /compact 开箱可用：config.compact 未配置时给默认压缩配置（对齐 schema 缺省值），
  // 否则 compactNow 直接返回 false 提示「未配置压缩」（后端 buildCompactConfig 的兜底在 main 同步）
  const compactConfig = buildCompactConfig(config, modelId, models) ?? {
    contextWindow: models?.resolve(modelId)?.model?.contextWindow ?? 128_000,
    maxOutputTokens: 8192,
    safetyMargin: 4096,
    keepRecentToolResults: 5,
  };
  // 撞线自动压缩开关：compactConfig 的有无只管压缩参数供给（手动 /compact 不受限），
  // 自动触发由本开关单独门控（Agent.autoCompact）
  const autoCompact = config.compact?.enabled !== false;
  // /init 过程免审批盒子：/init 执行期间置位，PermissionPipeline 的 autoApprove 活读放行
  const initPolicyBox: { value: boolean } = { value: false };
  const agentsFile = opts.projectAgentsFile ?? path.join(process.cwd(), "AGENTS.md");
  // 扩展生态装配（与 CLI 同套）：MCP server 工具 + 技能清单并入会话；
  // 启动失败的 server 已跳过，错误行 toast 一次提示、完整状态在 /mcp 面板
  const extensions = await assembleSessionExtensions(config, { logger });
  // 指令文件加载（与 CLI 同套）：用户级 + 项目侧逐级拼接进系统提示词
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
      // 扩展面板数据源（/mcp /skill）
      mcpServers: config.mcpServers ?? {},
      getMcpStatuses: () => extensions.mcpManager?.statuses() ?? [],
      skillsDisabled: config.skills?.disabled ?? [],
      // 设置面板数据源（/settings）：行启用态按合并配置生效值展示
      config,
      startupNotices: [...(opts.modelWarnings ?? []), ...extensions.mcpErrors],
      startupConnect: opts.startupConnect,
      shared: opts.shared,
      resetView: opts.resetView,
      hookStderr: hookStderrBox,
      terminal: opts.terminal,
      projectAgentsFile: opts.projectAgentsFile,
      tracesDir,
      // 状态行用量与水位（可观测性）：归一口径按协议区分；
      // 水位与压缩触发同口径（compactConfig 即压缩判断用的窗口参数）
      modelApi: (id) => models.resolve(id)?.model.api,
      contextWindow: compactConfig.contextWindow,
      compactThreshold: compactConfig.contextWindow - compactConfig.maxOutputTokens - compactConfig.safetyMargin,
      rebuildExtras: async () => {
        // 降级顺序：轨迹（全量含子 agent）→ 会话 meta.usage（仅主 agent、无缓存段）→ 无数据
        const rebuilt = await rebuildUsageFromTrace(
          path.join(tracesDir, `${session.meta.id}.jsonl`),
          (id) => models.resolve(id)?.model.api,
        );
        return {
          usage: rebuilt.usage ?? usageFromMessages(session.getMessages()),
          toolDurations: rebuilt.toolDurations,
        };
      },
      assemble: ({ approver, feedRoot }) => {
        const tools = [...createBuiltinTools(), ...extensions.tools];
        const systemPrompt = [SYSTEM_PROMPT, instructionsSection, extensions.promptSection]
          .filter((s) => s.length > 0)
          .join("\n");
        const readOnlyNames = new Set<string>([
          ...tools.filter((t) => t.isReadOnly).map((t) => t.name),
          // list_agents 为协作工具中的只读项，只能在 Agent 内部经 deps 构造、TUI 侧显式并入，
          // 需与 collab.ts 的 isReadOnly 保持同步
          "list_agents",
        ]);
        const pipelineOptions: PermissionPipelineOptions = {
          rules: [],
          approver,
          // plan 模式放行的只读工具集合（Tool.isReadOnly 收集）
          readOnlyTools: readOnlyNames,
          // mode 用 getter 活读 modeBox：Shift+Tab 切换即时作用于后续工具审批
          get mode() {
            return permissionModeBox.value;
          },
          // /init 过程免审批：只读工具 + 写项目根 AGENTS.md 自动放行，
          // 其余工具（bash、写其他路径等）仍走正常审批
          autoApprove: (request) => {
            if (!initPolicyBox.value) return false;
            if (readOnlyNames.has(request.toolName)) return true;
            if (request.toolName === "write") {
              const target = request.input?.path;
              return typeof target === "string" && path.resolve(target) === path.resolve(agentsFile);
            }
            return false;
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
          autoCompact,
          // 子 agent 提示词附加段：指令段与技能段派生时注入子 agent
          subagentPromptSections: [instructionsSection, extensions.promptSection],
          // 思考等级活引用：/model 左右调整后下一轮透传 reasoning_effort（仅支持的厂商）
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
        return { agent, team, initPolicyBox };
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