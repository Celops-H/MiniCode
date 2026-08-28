/**
 * TUI 驱动循环（R1b）：完整交互闭环——store 状态通道 + interact 接入 + 渲染挂载。
 * 交互经验继承 M4.3（tui-m43-ansi 的 loop.ts）：approver 待批队列一次放行全部、/compact 运行守卫、
 * 错误渲染进消息区不退出、turn 内打断、modal 态保留 Ctrl+C/D、双渲染流（onEvent/onRootEvent）都接。
 * 渲染：runTui 挂载 <App/>（opentui renderer），键盘经 App useKeyboard → mapKey → handleAction。
 */
import { createStore, reconcile } from "solid-js/store";
import { spawn } from "node:child_process";
import path from "node:path";
import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { Message } from "../core/index.js";
import type { StreamEvent } from "../core/index.js";
import { buildInitPrompt, readInstructionFile } from "../context/index.js";
import type { TuiAction } from "./keymap.js";
import { decideEsc } from "./keymap.js";
import { connectProvider, PROVIDER_PRESETS } from "./connect.js";
import { buildMcpRows, buildSkillRows, diffExtensionRows, setMcpServerEnabled, setSkillDisabled, type ExtensionRow } from "./extensions.js";
import { scanSkills } from "../skills/index.js";
import type { McpServerConfig } from "../config/index.js";
import type { McpServerStatus } from "../mcp/index.js";
import { initState, reduceAction, reduceEvent, reduceHook, interruptTurn, formatTime, promptEmpty, selectedPromptText, modelErrorText, resetToNewState, NEW_SESSION_ID, sessionModalTarget, cyclePermissionMode, permissionModeLabel, cycleThinkingLevel, thinkingLevelLabel, hasRunningAgent, type TuiState } from "./state.js";
import type { ThinkingLevel } from "../core/index.js";
import { App } from "./view/App.js";
import { interact } from "../cli/interact.js";
import { win32DisableProcessedInput, win32FlushInputBuffer } from "./win32.js";
import { tuiCursor } from "./cursor.js";
import type { Agent, Team } from "../agent/index.js";
import type { Session, SessionStore } from "../storage/index.js";
import { HookBus } from "../hooks/index.js";
import type { HookBus as HookBusType } from "../hooks/index.js";
import type { PermissionApprover, PermissionDecision, PermissionRequest, PermissionMode } from "../permission/index.js";

/** 纯 reducer 通道（测试/简单装配用）：动作 → state 整树替换，无副作用 */
export interface TuiChannel {
  state: TuiState;
  onAction: (action: TuiAction) => void;
}

/** 复制文本到系统剪贴板（Windows PowerShell，显式 UTF8 解码 stdin——默认 OEM 代码页会把中文/emoji 变乱码，问题 38；方案对齐 opencode） */
export function copyToClipboard(text: string): void {
  const child = spawn(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  child.on("error", () => undefined); // powershell 缺失等环境异常静默忽略（复制失败不打断交互）
  child.stdin.end(text);
}

/** 建立纯 reducer 通道（R1a；R1b 的 runTui 内部使用带副作用的完整处理） */
export function createChannel(initialMessages: Message[]): TuiChannel {
  const [state, setState] = createStore<TuiState>(initState(initialMessages));
  return {
    get state() {
      return state;
    },
    onAction: (action) => setState(reconcile(reduceAction(state, action))),
  };
}

/** 瞬时提示显示时长 */
const TOAST_MS = 5000;

export interface TuiLoopOptions {
  /** 装配回调：通道就绪后由入口层用 approver/feedRoot/hooks 构造 agent（多 agent 时带 team，供级联中断/收尾清理） */
  assemble: (channel: {
    approver: PermissionApprover;
    feedRoot: (event: StreamEvent) => void;
    hooks: HookBusType;
  }) => { agent: Agent; team?: Team };
  store: SessionStore;
  session: Session;
  hooks?: HookBusType;
  /** 状态行模型名 */
  modelLabel: string;
  /** 权限模式的可变盒子（装配层用它把模式回灌 PermissionPipeline；Shift+Tab 在这里同步） */
  permissionMode?: { value: PermissionMode };
  /** 思考等级可变盒子（/model 左右调整；装配层经 Agent.thinkingLevelRef 每轮透传 reasoning_effort） */
  thinkingLevel?: { value: ThinkingLevel | undefined };
  /** 全部配置模型列表（/@/model 弹窗数据源） */
  modelList?: Array<{ id: string }>;
  /** 已配置 MCP 服务（/mcp 面板数据源，BACKEND §19） */
  mcpServers?: Record<string, McpServerConfig>;
  /** MCP 装配状态活读取（/mcp 面板连接状态列；随会话装配注入） */
  getMcpStatuses?: () => McpServerStatus[];
  /** 技能关闭名单（config.skills.disabled 全局/项目并集，/skill 面板行启用态用） */
  skillsDisabled?: string[];
  /** 会话启动通知（MCP 启动失败错误行等）：挂载后 toast 一次，完整状态在 /mcp 面板 */
  startupNotices?: string[];
  /** 项目根 AGENTS.md 路径（/init 用，测试可注入）；缺省 <cwd>/AGENTS.md */
  projectAgentsFile?: string;
}

/** TUI 会话循环：挂载渲染 + interact 主循环；返回 /session 切换或 /connect 重建信号 */
export async function runTui(options: TuiLoopOptions): Promise<{ switchTo?: string; reconfigure?: boolean } | undefined> {
  const { store, session, modelLabel } = options;
  const hooks: HookBusType = options.hooks ?? new HookBus();
  const [state, setState] = createStore<TuiState>(initState(session.getMessages(), session.meta.title));

  let agent: Agent;
  /** 多 agent 团队（assemble 装配；Esc 级联中断子 agent、退出清理用；单 agent 时 undefined） */
  let team: Team | undefined;
  let runningLoop = true;
  let wake: (() => void) | undefined;
  const pendingInputs: string[] = [];
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** 挂起的权限请求：并发批工具同时请求时排队（approver 各持等待决策 promise），一次按键应用到全部 */
  let pendingPerms: Array<{ resolve: (d: PermissionDecision) => void }> = [];
  /** /session 面板选中切换目标（选定后退出循环由装配层重建） */
  let pendingSwitch: string | undefined;
  /** /connect 成功后请求装配层重读配置并重建会话（reconfigure 信号） */
  let pendingReconfigure = false;
  /** /mcp /skill 面板打开时的行启用态基线（Enter 应用时按 id 比对出改动行，只写改动） */
  let extensionsBaseline: Partial<Record<"mcp" | "skill", Array<{ id: string; enabled: boolean }>>> = {};
  /** 打断后忽略本回合迟到增量（后端中断收尾不发 done，残余事件丢弃） */
  let ignoreStream = false;
  /** Esc 双击退出：运行中 Esc=打断；空闲第一次 Esc 计时，800ms 内再次 Esc 退出 */
  const ESC_EXIT_WINDOW_MS = 800;
  let lastEscAt = 0;
  /** 权限模式盒子（Shift+Tab 切换；装配层 PermissionPipeline 用它做活引用，见 assemble） */
  const modeBox: { value: PermissionMode } = options.permissionMode ?? { value: "default" };
  /** 思考等级盒子（/@/model 左右调整；装配层 Agent.thinkingLevelRef 每轮读它透传） */
  const thinkingBox: { value: ThinkingLevel | undefined } = options.thinkingLevel ?? { value: undefined };

  const commit = (next: TuiState): void => setState(reconcile(next));

  /** 输入源：TUI 发送队列 → interact 逐行消费 */
  async function* inputSource(): AsyncIterable<string> {
    while (runningLoop) {
      if (pendingInputs.length > 0) yield pendingInputs.shift()!;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  const showToast = (text: string): void => {
    const clean = text.replace(/\s*\n\s*/g, " ").trim();
    if (clean) {
      commit({ ...state, toast: { text: clean, key: Date.now() } });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastTimer = undefined;
        if (state.toast) commit({ ...state, toast: undefined });
      }, TOAST_MS);
    }
  };

  /** 流式事件 → reducer（用户输入驱动 + root 后台驱动都经此，双渲染流两侧都接） */
  const feedEvent = (event: StreamEvent): void => {
    if (
      ignoreStream &&
      (event.type === "text_delta" || event.type === "thinking_delta" || event.type.startsWith("toolcall"))
    ) {
      return;
    }
    // model_fallback（模型路由切换）由 reduceEvent 追加常驻通知行到消息区，不 toast 一闪而过
    commit(reduceEvent(state, event));
  };
  const onEvent = feedEvent;
  const feedRoot = feedEvent;
  const write = (text: string): void => {
    const clean = text.replace(/\s*\n\s*/g, " ").trim();
    if (clean && !clean.startsWith("[工具结果]")) showToast(clean);
  };

  /** 权限决策应用到全部待批（并发批一次按键），清弹块 */
  const resolvePermission = (decision: "allow" | "allow-all" | "deny", denyReason = "用户拒绝"): void => {
    const perms = pendingPerms;
    pendingPerms = [];
    if (perms.length === 0) return;
    const resolved: PermissionDecision =
      decision === "allow"
        ? { action: "allow" }
        : decision === "allow-all"
          ? { action: "allow", remember: true }
          : { action: "deny", reason: denyReason };
    commit({ ...state, modal: undefined });
    for (const perm of perms) perm.resolve(resolved);
  };

  /** 权限审批：渲染弹块并等待键盘决策（供装配方作 PermissionPipeline.approver） */
  const approver: PermissionApprover = (request: PermissionRequest) =>
    new Promise<PermissionDecision>((resolve) => {
      pendingPerms.push({ resolve });
      commit({
        ...state,
        modal: {
          kind: "permission",
          toolName: request.toolName,
          content: typeof request.content === "string" ? request.content : undefined,
          argsText: JSON.stringify(request.input ?? {}),
          selected: 0,
        },
      });
    });

  const handleCommand = (raw: string): void => {
    const command = raw.trim();
    if (command === "/exit") {
      if (state.status === "running") {
        agent.interrupt();
        resolvePermission("deny");
      }
      exitLoop();
      return;
    }
    if (command === "/compact" || command.startsWith("/compact ")) {
      if (state.status === "running") {
        showToast("运行中不可压缩，等本轮结束后再试");
        commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
        return;
      }
      const guidance = command === "/compact" ? undefined : command.slice("/compact ".length).trim() || undefined;
      commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
      void compactAsync(guidance).catch(() => undefined);
      return;
    }
    if (command === "/init") {
      // 分析代码库生成/改进项目根 AGENTS.md（BACKEND §21）：读现有文件生成 init 提示词，
      // 走正常回合让模型用 write 工具落盘；已存在时提示词要求不覆盖、先建议改进
      if (state.status === "running") {
        showToast("运行中不可执行 /init，等本轮结束后再试");
        commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
        return;
      }
      const agentsFile = options.projectAgentsFile ?? path.join(process.cwd(), "AGENTS.md");
      void (async () => {
        try {
          const existing = await readInstructionFile(agentsFile);
          pendingInputs.push(buildInitPrompt(existing));
          wake?.();
          showToast(existing ? "已存在 AGENTS.md：开始分析并建议改进（不覆盖）" : "开始分析代码库，生成项目根 AGENTS.md");
        } catch (err) {
          showToast(`读取 AGENTS.md 失败：${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
      return;
    }
    if (command === "/help") {
      showToast("命令：/exit 退出 · /compact [指导] 压缩 · /init 生成 AGENTS.md · /session 切换 · /connect 连接 · /model 模型 · /mcp 服务 · /skill 技能 · /rename 改名 · /clear 清空 · /help 帮助 · Esc 打断（连按两次退出）");
      commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
      return;
    }
    if (command === "/session") {
      // 运行中拒绝（G-5=43：与 /compact 等守卫一致——运行中切会话会把当前回合作废，删除交互风险面更大）
      if (state.status === "running") {
        showToast("运行中不可切换会话，等本轮结束后再试");
        commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
        return;
      }
      commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
      void openSessionModal().catch(() => undefined);
      return;
    }
    if (command === "/connect") {
      // 运行中拒绝（重建链会把当前回合作废）；否则打开供应商选择弹窗
      if (state.status === "running") {
        showToast("运行中不可切换供应商，等本轮结束后再试");
        commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
        return;
      }
      commit({
        ...state,
        modal: {
          kind: "connect",
          providers: PROVIDER_PRESETS.map((p) => ({ id: p.id, name: p.name, defaultModel: p.defaultModel })),
          selected: 0,
        },
        prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null },
        candidate: undefined,
      });
      return;
    }
    if (command === "/model") {
      // 显示当前配置的模型列表：↑↓ 选模型、←→ 调思考等级、Enter 应用（运行中同样等本轮结束）
      if (state.status === "running") {
        showToast("运行中不可切换模型，等本轮结束后再试");
        commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
        return;
      }
      const models = options.modelList ?? [];
      const current = session.meta.model;
      const selected = Math.max(0, models.findIndex((m) => m.id === current));
      // 初始思考等级读 thinkingBox.value（真实生效值；state.thinkingLevel 可能因 reconfigure 重置，
      // 读它会在切模型后弹窗显示错值、且 Enter 会静默重置 box）
      commit({
        ...state,
        modal: { kind: "model", models, selected, thinkingLevel: thinkingBox.value },
        prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null },
        candidate: undefined,
      });
      return;
    }
    if (command === "/mcp" || command === "/skill") {
      // 扩展面板（UI-SPEC §8b）：查看 MCP 服务/技能并切换启用/关闭，Enter 写回定义层并重装配
      // （BACKEND §19/§20）；重装配会重建 agent，运行中拒绝（同 /model 守卫）
      if (state.status === "running") {
        showToast(command === "/mcp" ? "运行中不可管理 MCP 服务，等本轮结束后再试" : "运行中不可管理技能，等本轮结束后再试");
        commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
        return;
      }
      commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
      void openExtensionsModal(command === "/mcp" ? "mcp" : "skill").catch(() => undefined);
      return;
    }
    if (command === "/rename" || command.startsWith("/rename ")) {
      // /rename 会话名：改会话标题并落盘（复用现有 API：meta 可变 + rewriteMessages 持久化），
      // 同时同步 UI store 的 title（状态行会话名随 /rename 更新）
      const renameTitle = command.slice("/rename".length).trim();
      if (!renameTitle) {
        showToast("用法：/rename 会话名");
        commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
      } else {
        session.meta.title = renameTitle;
        commit({ ...state, title: renameTitle, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
        void store
          .rewriteMessages(session, session.getMessages())
          .then(() => showToast(`会话已重命名：${renameTitle}`))
          .catch(() => showToast("重命名失败：写入会话文件出错"));
      }
      return;
    }
    if (command === "/clear") {
      // 运行守卫：运行中清屏会抹掉当前回合用户消息块与进行中的工具卡，破坏视图连续性
      if (state.status === "running") {
        showToast("运行中不可清空，等本轮结束后再试");
        commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
        return;
      }
      // 回会话新建态：agent 上下文清空（防下一轮 start() 把旧历史回灌模型并重写回文件）
      //  + 会话消息清盘 + UI 重置；会话条目与标题保留（用户复核：/clear 只清消息，会话名不变）
      agent.resetHistory();
      commit(resetToNewState(state));
      void store
        .rewriteMessages(session, [])
        .then(() => showToast("已清空，回到新会话"))
        .catch(() => showToast("清空失败：写入会话文件出错"));
      return;
    }
    showToast(`未知命令 ${command}（/help 查看可用命令）`);
    commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0, sel: null }, candidate: undefined });
  };

  /** 连接写盘是否进行中（防重入：连按 Enter 并发写全局 config 会 read-modify-write 互相覆盖，丢其它配置） */
  let connecting = false;

  /** /connect key 输入态确认：从弹窗内 key 缓冲取 API Key → 写全局 config + 项目 .env。 */
  const submitConnectKey = async (): Promise<void> => {
    const conn = state.modal;
    if (!conn || conn.kind !== "connect-key") return;
    const preset = PROVIDER_PRESETS.find((p) => p.id === conn.providerId);
    if (!preset) return;
    if (connecting) return;
    connecting = true;
    try {
      const key = conn.key.trim();
      const result = await connectProvider(preset, key);
      // await 期间用户 Esc 取消（弹窗关闭）：写配置副作用已发生、不可中止——配置实际已写入，
      // 提示用户；当前会话未重建（模型保持），要使用新厂商可再 /model 选
      if (state.modal?.kind !== "connect-key") {
        if (result.ok) showToast("配置已写入（连接成功），当前会话未切换：可 /model 使用新厂商");
        return;
      }
      if (result.ok) {
        // 拉全量模型成功带数量提示（N1）；未拉到静默（回落预设占位，/model 仍可用预设模型）
        const fetched = result.fetchedModels != null ? `，已拉取 ${result.fetchedModels} 个模型` : "";
        showToast(`${conn.providerName} 已连接${fetched}，正在重建会话…`);
        pendingReconfigure = true;
        exitLoop();
        return;
      }
      showToast(result.error ?? "连接失败");
      commit({ ...state, modal: { ...conn, key: "" } });
    } finally {
      connecting = false;
    }
  };

  /** /compact：强制压缩 + 历史重写落盘（F-1=56 toast 带压缩后条数，压缩有痕迹）；
   *  带指导时按指导侧重视现场场摘要（DESIGN 9.8），无指导保留记忆替代省调用路径 */
  const compactAsync = async (guidance?: string): Promise<void> => {
    if (await agent.compactNow(guidance)) {
      await store.rewriteMessages(session, agent.getMessages());
      agent.consumeHistoryRewritten();
      const n = agent.getMessages().length;
      showToast(`会话历史已压缩${guidance ? "（按压缩指导）" : ""}：当前 ${n} 条消息，关键上下文已保留`);
    } else {
      showToast("未配置压缩或摘要不可用");
    }
  };

  /** 打开会话切换面板 */
  const openSessionModal = async (): Promise<void> => {
    const sessions = await store.listSessions();
    commit({
      ...state,
      modal: {
        kind: "session",
        // 当前活跃会话不展示（列表=切换其它会话用，P4-2：删除只作用于其它会话，避免误删本会话）
        sessions: sessions
          .filter((s) => s.id !== session.meta.id)
          .map((s) => ({ id: s.id, title: s.title ?? "", model: s.model, updatedAt: s.updatedAt, sizeBytes: s.sizeBytes })),
        // selected 0=新建会话（置顶默认选中，P6-4）；1..n=会话
        selected: 0,
        action: "enter",
      },
    });
  };

  /** 打开 /mcp 或 /skill 扩展面板（UI-SPEC §8b）：mcp 行来自配置+manager 装配状态，
   *  skill 行现扫技能目录（打开时新鲜扫描，改技能目录无需重开会话即可见） */
  const openExtensionsModal = async (kind: "mcp" | "skill"): Promise<void> => {
    let rows: ExtensionRow[];
    try {
      rows = kind === "mcp"
        ? buildMcpRows(options.mcpServers ?? {}, options.getMcpStatuses?.() ?? [])
        : buildSkillRows(await scanSkills(), options.skillsDisabled ?? []);
    } catch (err) {
      showToast(`打开面板失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // 基线快照：Enter 应用时按 id 比对，只把改动行写回配置
    extensionsBaseline[kind] = rows.map((r) => ({ id: r.id, enabled: r.enabled }));
    commit({ ...state, modal: { kind, rows, selected: 0 } });
  };

  /** 扩展面板写盘进行中（防重入：连按 Enter 并发写同一配置文件会 read-modify-write 互相覆盖，同 /connect 的 connecting） */
  let applyingExtensions = false;

  /** 扩展面板 Enter 应用：改动行按「写回定义层」规则落配置（BACKEND §19/§20 回写规则），
   *  成功即重装配（当前会话立即生效）；无改动仅关闭 */
  const applyExtensions = (kind: "mcp" | "skill", rows: ExtensionRow[]): void => {
    const changed = diffExtensionRows(extensionsBaseline[kind] ?? [], rows);
    if (changed.length === 0) {
      showToast("未做改动");
      return;
    }
    if (applyingExtensions) return;
    applyingExtensions = true;
    void (async () => {
      try {
        for (const row of changed) {
          if (kind === "mcp") await setMcpServerEnabled(row.id, row.enabled);
          else await setSkillDisabled(row.id, !row.enabled, row.source ?? "project");
        }
        showToast(kind === "mcp" ? "MCP 服务配置已写入，正在重装配…" : "技能配置已写入，正在重装配…");
        pendingReconfigure = true;
        exitLoop();
      } catch (err) {
        showToast(`写入配置失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        applyingExtensions = false;
      }
    })();
  };

  const exitLoop = (): void => {
    runningLoop = false;
    wake?.();
    wake = undefined;
  };

  /** 打断当前轮：级联中断全部子 agent（多 agent）或主 agent（单 agent）+ 拒绝待批权限 + 忽略迟到增量 + 界面收尾 */
  const doInterrupt = (): void => {
    if (team) team.interruptAll();
    else agent.interrupt();
    resolvePermission("deny", "用户打断");
    ignoreStream = true;
    commit(interruptTurn(state));
    lastEscAt = 0;
  };

  /** 键盘/动作 → reducer + 副作用（App onAction 接这里） */
  const handleAction = (action: TuiAction): void => {
    switch (action.type) {
      case "send": {
        // 空输入 Enter：不再折叠最后一个可折叠块（展开/收起已改鼠标点击，Enter 保留发送）
        if (promptEmpty(state.prompt)) return;
        const text = state.prompt.lines.join("\n");
        if (!text.trim()) return;
        if (text.startsWith("/")) handleCommand(text);
        else {
          pendingInputs.push(text);
          wake?.();
          commit(reduceAction(state, action));
        }
        return;
      }
      case "paste": {
        // 粘贴：bracketed paste 整段插入（reducer 处理多行/超行数/connect-key key 缓冲）
        commit(reduceAction(state, action));
        return;
      }
      case "copy": {
        // Ctrl+C 复制：优先输入框选区（Shift 选择，B-2），其次消息区 opentui 拖选选区；
        // 有输入框选区（含空选区）先清 sel，空选区不复制回落消息区；复制后清对应选区 + toast
        const r = renderer as
          | { getSelection?: () => { getSelectedText?: () => string } | null; clearSelection?: () => void }
          | undefined;
        if (state.prompt.sel) {
          const promptText = selectedPromptText(state.prompt);
          if (promptText) {
            copyToClipboard(promptText);
            showToast(`已复制 ${Array.from(promptText).length} 个字符到剪贴板`);
            commit({ ...state, prompt: { ...state.prompt, sel: null } });
            r?.clearSelection?.();
            return;
          }
          // 输入框选区为空（Shift 选过但无文本）：清选区后回落消息区拖选复制（审查 M2 行为与注释一致）
          commit({ ...state, prompt: { ...state.prompt, sel: null } });
        }
        const sel = r?.getSelection?.();
        const text = sel?.getSelectedText?.();
        if (text) {
          copyToClipboard(text);
          r?.clearSelection?.();
          showToast(`已复制 ${Array.from(text).length} 个字符到剪贴板`);
        }
        return;
      }
      case "modal-confirm": {
        if (state.modal) {
          if (state.modal.kind === "permission") {
            const option = ["allow", "allow-all", "deny"][state.modal.selected] as "allow" | "allow-all" | "deny";
            resolvePermission(option);
          } else if (state.modal.kind === "connect") {
            // 选定供应商 → 留在弹窗进入 key 输入态（弹窗内输 key，Enter 提交 / Esc 取消）
            const connModal = state.modal;
            const preset = PROVIDER_PRESETS.find((p) => p.id === connModal.providers[connModal.selected]?.id);
            if (preset) {
              commit({
                ...state,
                modal: {
                  kind: "connect-key",
                  providerId: preset.id,
                  providerName: preset.name,
                  apiKeyEnv: preset.apiKeyEnv,
                  defaultModel: preset.defaultModel,
                  key: "",
                },
              });
            }
          } else if (state.modal.kind === "connect-key") {
            // key 输入态 Enter：提交连接（写配置成功后由 submitConnectKey 请求重建）
            void submitConnectKey();
          } else if (state.modal.kind === "model") {
            // 应用 /model：切模型（同一会话用新模型续跑）+ 思考等级即时生效
            const picked = state.modal.models[state.modal.selected];
            thinkingBox.value = state.modal.thinkingLevel;
            commit({ ...state, modal: undefined, thinkingLevel: state.modal.thinkingLevel });
            if (picked && picked.id !== session.meta.model) {
              session.meta.model = picked.id;
              void store
                .rewriteMessages(session, session.getMessages())
                .then(() => {
                  showToast(`模型已切换：${picked.id}`);
                  pendingReconfigure = true;
                  pendingSwitch = session.meta.id; // 同一会话用新模型续跑，历史保留
                  exitLoop();
                })
                .catch(() => showToast("切换模型失败：写入会话文件出错"));
            } else {
              showToast(`思考等级：${thinkingLevelLabel(state.modal.thinkingLevel)}`);
            }
          } else if (state.modal.kind === "mcp") {
            // 应用扩展面板：写回定义层配置并重装配（无改动仅关闭）。
            // 先取 rows 再 commit：solid reconcile 会把 undefined 键从 store 清掉，
            // commit 之后再读 state.modal 是 undefined（P0 教训，同 Modal.tsx 文件头陷阱注记）
            const rows = state.modal.rows;
            commit({ ...state, modal: undefined });
            applyExtensions("mcp", rows);
          } else if (state.modal.kind === "skill") {
            const rows = state.modal.rows;
            commit({ ...state, modal: undefined });
            applyExtensions("skill", rows);
          } else {
            // /session 会话面板：进入 = 切换目标（退出循环由装配层重建）；删除 = 一步删除并刷新列表。
            // selected 0=新建会话、1..n=会话（P6-4 新建置顶，索引映射见 sessionModalTarget）
            const target = sessionModalTarget(state.modal.selected, state.modal.sessions);
            if (state.modal.action === "delete" && target.kind === "session") {
              const targetId = target.id;
              // 回调外捕获选中下标：异步内 state.modal 不受外层 if 的 narrowing（TS 报 possibly undefined）
              const delSelected = state.modal.selected;
              void (async () => {
                try {
                  await store.deleteSession(targetId);
                  const sessions = await store.listSessions();
                  const remaining = sessions.filter((s) => s.id !== session.meta.id);
                  commit({
                    ...state,
                    modal: {
                      kind: "session",
                      sessions: remaining.map((s) => ({ id: s.id, title: s.title ?? "", model: s.model, updatedAt: s.updatedAt, sizeBytes: s.sizeBytes })),
                      // 删除后选中落原位置下一项：删除 selected=k 的会话（会话下标 k-1），删除后仍选中
                      // selected=k（原下一会话前移到下标 k-1）；删末位则 clamp 到新列表末位
                      selected: Math.min(delSelected, remaining.length),
                      action: "enter",
                    },
                  });
                  showToast("会话已删除");
                } catch {
                  showToast("删除会话失败");
                }
              })();
            } else {
              pendingSwitch = target.kind === "new" ? NEW_SESSION_ID : target.id;
              exitLoop();
            }
          }
          return;
        }
        // slash 候选态 Enter = 执行选中的命令（M4.3 语义，UI-SPEC §6「Enter 用选中的命令」）
        const candidate = state.candidate;
        if (candidate) {
          const item = candidate.items[candidate.selected];
          if (item) handleCommand(item);
        }
        return;
      }
      case "permission": {
        if (state.modal) resolvePermission(action.decision);
        return;
      }
      case "modal-nav": {
        if (state.modal) {
          if (state.modal.kind === "permission") {
            const selected = Math.max(0, Math.min(2, state.modal.selected + action.dir));
            commit({ ...state, modal: { ...state.modal, selected } });
          } else if (state.modal.kind === "connect") {
            const max = state.modal.providers.length - 1;
            commit({ ...state, modal: { ...state.modal, selected: Math.max(0, Math.min(max, state.modal.selected + action.dir)) } });
          } else if (state.modal.kind === "model") {
            const max = state.modal.models.length - 1;
            commit({ ...state, modal: { ...state.modal, selected: Math.max(0, Math.min(max, state.modal.selected + action.dir)) } });
          } else if (state.modal.kind === "mcp") {
            const max = state.modal.rows.length - 1;
            commit({ ...state, modal: { ...state.modal, selected: Math.max(0, Math.min(max, state.modal.selected + action.dir)) } });
          } else if (state.modal.kind === "skill") {
            const max = state.modal.rows.length - 1;
            commit({ ...state, modal: { ...state.modal, selected: Math.max(0, Math.min(max, state.modal.selected + action.dir)) } });
          } else if (state.modal.kind === "connect-key") {
            // key 输入态无列表导航（mapModalKey 已把方向键映射为 noop，这里是类型收尾）
            return;
          } else {
            const max = state.modal.sessions.length;
            // 移动选中行时操作态重置为「进入」（删除是瞬态选择，换行后默认进入）
            commit({
              ...state,
              modal: { ...state.modal, selected: Math.max(0, Math.min(max, state.modal.selected + action.dir)), action: "enter" },
            });
          }
        } else {
          commit(reduceAction(state, action));
        }
        return;
      }
      case "session-action-toggle": {
        // /session 面板 ←→：切换当前行操作态（进入 ↔ 删除）
        if (state.modal?.kind === "session") {
          // 新建行（selected 0）无删除操作态（P6-4）：恒为进入，←→ 不切删除避免「新建行显示删除」歧义（N-1）
          const action = state.modal.selected === 0 ? "enter" : state.modal.action === "enter" ? "delete" : "enter";
          commit({
            ...state,
            modal: { ...state.modal, action },
          });
        }
        return;
      }
      case "cancel": {
        if (state.modal) {
          if (state.modal.kind === "permission") resolvePermission("deny");
          else commit({ ...state, modal: undefined });
        } else {
          commit(reduceAction(state, action));
        }
        return;
      }
      case "esc": {
        // Esc：有折叠聚焦先取消聚焦；运行中或子 agent 活跃时打断；空闲第一次 arm、窗口内第二次退出。
        // 子 agent 活跃时主状态可能非 running（主 agent 在等结论）——判定并入 agent 树运行态，
        // 否则 Esc 会被 arm 成双击退出、按两次才打断（P8）
        const verdict = decideEsc({
          hasFocus: state.focusIndex >= 0,
          running: state.status === "running" || hasRunningAgent(state.agents),
          lastEscAt,
          now: Date.now(),
          windowMs: ESC_EXIT_WINDOW_MS,
        });
        if (verdict === "focus-clear") {
          commit({ ...state, focusIndex: -1 });
          return;
        }
        if (verdict === "interrupt") {
          doInterrupt();
          return;
        }
        if (verdict === "exit") {
          exitLoop();
          return;
        }
        lastEscAt = Date.now();
        showToast("再按一次 Esc 退出");
        return;
      }
      case "interrupt": {
        if (state.status === "running") doInterrupt();
        else exitLoop();
        return;
      }
      case "exit": {
        if (state.status === "running") {
          agent.interrupt();
          resolvePermission("deny", "用户打断");
        }
        exitLoop();
        return;
      }
      case "mode-cycle": {
        // Shift+Tab 切换权限模式：default(正常审批) → plan(只读放行) → bypassPermissions(自动放行)
        const next = cyclePermissionMode(state.permissionMode);
        modeBox.value = next;
        commit({ ...state, permissionMode: next });
        const note =
          next === "plan"
            ? "只放行只读工具"
            : next === "bypassPermissions"
              ? "自动放行，保留危险命令检查"
              : "正常审批";
        showToast(`权限模式：${permissionModeLabel(next)}（${note}）`);
        return;
      }
      case "thinking-adjust": {
        // /model 弹窗 ←→：只改弹窗内候选等级（Enter 应用才写 thinkingBox，Esc 取消不改——「应用/取消」语义自洽）
        if (state.modal?.kind !== "model") return;
        const next = cycleThinkingLevel(state.modal.thinkingLevel);
        commit({ ...state, modal: { ...state.modal, thinkingLevel: next } });
        return;
      }
      case "extensions-toggle": {
        // /mcp /skill 面板 ←→：只改弹窗内候选启用态（Enter 应用才写配置，Esc 取消不改——同 /model 语义）
        const extModal = state.modal;
        if (extModal?.kind !== "mcp" && extModal?.kind !== "skill") return;
        const rows = extModal.rows.map((r, i) => (i === extModal.selected ? { ...r, enabled: !r.enabled } : r));
        commit({ ...state, modal: { ...extModal, rows } });
        return;
      }
      case "fold-at": {
        // 折叠点击（鼠标 onMouseUp 触发）：同时清除应用内选区——点击在可选中文本上会留单点/拖选高亮
        //（问题 34），折叠交互不需要选区，清掉避免误以为选中文字
        (renderer as { clearSelection?: () => void } | undefined)?.clearSelection?.();
        commit(reduceAction(state, action));
        return;
      }
      default:
        commit(reduceAction(state, action));
    }
  };

  // Windows 终端输入初始化（对齐 opencode）：清输入缓冲在进 TUI 前，PROCESSED_INPUT
  // 必须在 createCliRenderer 之后清——原生 setupTerminal 会重设控制台模式，先清会被盖回
  win32FlushInputBuffer();
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    // 强制 JS 渲染（useThread false）：与测试/headless 路径一致，渲染输出经 stdout.write 直达终端
    // （headless 下已实测：store 更新后的帧内容确实写出，含输入字符）。原生线程路径此前在真机
    // 与诊断期 stderr 噪声叠加时未验证成功，先保持 JS 路径可靠。
    useThread: false,
    targetFps: 60,
    autoFocus: false,
    openConsoleOnError: false,
    // 鼠标：开启后滚动条拖拽/滚轮滚动由 opentui 原生承担，点击折叠等由视图 onMouseUp 接线
    useMouse: true,
    // kitty 键盘协议：让 Ctrl+J（换行）等组合键带修饰标志独立到达；不支持的终端自动回退（Ctrl+J 退化为 Enter）
    useKittyKeyboard: {},
  });
  win32DisableProcessedInput();

  // 装配通知（MCP 启动失败错误行等）：toast 一次提示去向（/mcp 面板有完整连接状态），不打断进入
  if (options.startupNotices?.length) showToast(options.startupNotices.join("；"));

  await render(
    () => <App state={state} model={modelLabel} onAction={handleAction} />,
    renderer,
  );

  // D-1=36 光标定位：每帧把终端光标移到输入框光标处（不占格，替代插入字符「│」）；
  // 闪烁由定时器翻 tuiCursor.visible 并触发重渲（postProcessFn 随帧执行 setCursorPosition）
  renderer.addPostProcessFn(() => {
    renderer.setCursorPosition(tuiCursor.col, tuiCursor.row, tuiCursor.enabled && tuiCursor.visible);
  });
  const blinkTimer = setInterval(() => {
    if (tuiCursor.enabled) {
      tuiCursor.visible = !tuiCursor.visible;
      renderer.requestRender();
    }
  }, 500);

  // 通道就绪：入口层装配 agent（approver/feedRoot/hooks 注入权限管线与双渲染流）
  ({ agent, team } = options.assemble({ approver, feedRoot, hooks }));

  // 订阅 Hook 事件渲染（会话/工具/子 agent）都进同一 reducer
  const unsubscribeHooks = [
    hooks.on("UserPromptSubmit", (e) => {
      ignoreStream = false;
      commit(reduceHook(state, e));
    }),
    hooks.on("PreToolUse", (e) => commit(reduceHook(state, e))),
    hooks.on("PostToolUse", (e) => commit(reduceHook(state, e))),
    hooks.on("PostToolUseFailure", (e) => commit(reduceHook(state, e))),
    hooks.on("AgentSpawned", (e) => commit(reduceHook(state, { ...e, spawnedAt: Date.now() }))),
    hooks.on("AgentCompleted", (e) => commit(reduceHook(state, { ...e, completedAt: Date.now() }))),
    hooks.on("AgentInterrupted", (e) => commit(reduceHook(state, { ...e, completedAt: Date.now() }))),
    hooks.on("Stop", (e) => commit(reduceHook(state, e))),
  ];

  // 会话级事件由宿主触发：全部订阅就绪后发会话开始
  await hooks?.emit({ type: "SessionStart" });

  // 交互主循环：运行错误渲染进消息区并重建输入循环（错误不退出进程）
  try {
    while (runningLoop) {
      try {
        await interact({ agent, store, session, inputs: inputSource(), write, onEvent, hooks });
        break;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ignoreStream = false;
        commit({
          ...state,
          blocks: [
            ...state.blocks,
            {
              kind: "message",
              id: `err_${state.blocks.length}`,
              role: "assistant",
              // 错误块标题行已带 ⚠（Messages 组件 isError 标题），text 不再加前缀防双 ⚠；
              // modelErrorText 对模型类错误附「换模型/配 key」引导
              text: modelErrorText(error),
              isError: true,
              time: formatTime(),
              thinkingCollapsed: true,
            },
          ],
          streaming: undefined,
          status: "idle",
        });
      }
    }
  } finally {
    runningLoop = false;
    if (toastTimer) clearTimeout(toastTimer);
    clearInterval(blinkTimer);
    for (const off of unsubscribeHooks) off();
    // 先还原终端（renderer.destroy）再发会话结束事件：防 SessionEnd handler 的 stdout
    // 写进 raw/备用屏；destroy 包 try（渲染器初始化失败等边缘路径也不漏还原）
    try {
      renderer.destroy();
    } catch {
      // 渲染器已不可用，忽略
    }
    try {
      await hooks?.emit({ type: "SessionEnd" });
    } catch {
      // 会话结束事件处理失败不阻断退出
    }
    // 会话收尾清理团队：中断活跃子 agent、清空注册表（防后台 resume 循环吊住进程、成员残留到下次装配）
    team?.clear();
  }
  // /session 切换到其它会话 / /connect 重建链：只有改会话或请求重建任一发生才返回信号；
  // 仅 reconfigure（connect 保持同会话）时 switchTo 留空，由装配层加载同一会话
  return pendingSwitch || pendingReconfigure ? { switchTo: pendingSwitch, reconfigure: pendingReconfigure } : undefined;
}