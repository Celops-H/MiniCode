/**
 * TUI 驱动循环（R1b）：完整交互闭环——store 状态通道 + interact 接入 + 渲染挂载。
 * 交互经验继承 M4.3（tui-m43-ansi 的 loop.ts）：approver 待批队列一次放行全部、/compact 运行守卫、
 * 错误渲染进消息区不退出、turn 内打断、modal 态保留 Ctrl+C/D、双渲染流（onEvent/onRootEvent）都接。
 * 渲染：runTui 挂载 <App/>（opentui renderer），键盘经 App useKeyboard → mapKey → handleAction。
 */
import { createStore, reconcile } from "solid-js/store";
import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { Message } from "../core/index.js";
import type { StreamEvent } from "../core/index.js";
import type { TuiAction } from "./keymap.js";
import { decideEsc } from "./keymap.js";
import { connectProvider, PROVIDER_PRESETS } from "./connect.js";
import { initState, reduceAction, reduceEvent, reduceHook, interruptTurn, formatTime, promptEmpty, NEW_SESSION_ID, cyclePermissionMode, permissionModeLabel, cycleThinkingLevel, thinkingLevelLabel, type TuiState } from "./state.js";
import type { ThinkingLevel } from "../core/index.js";
import { App } from "./view/App.js";
import { interact } from "../cli/interact.js";
import { win32DisableProcessedInput, win32FlushInputBuffer } from "./win32.js";
import type { Agent } from "../agent/index.js";
import type { Session, SessionStore } from "../storage/index.js";
import { HookBus } from "../hooks/index.js";
import type { HookBus as HookBusType } from "../hooks/index.js";
import type { PermissionApprover, PermissionDecision, PermissionRequest, PermissionMode } from "../permission/index.js";

/** 纯 reducer 通道（测试/简单装配用）：动作 → state 整树替换，无副作用 */
export interface TuiChannel {
  state: TuiState;
  onAction: (action: TuiAction) => void;
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
  /** 装配回调：通道就绪后由入口层用 approver/feedRoot/hooks 构造 agent */
  assemble: (channel: {
    approver: PermissionApprover;
    feedRoot: (event: StreamEvent) => void;
    hooks: HookBusType;
  }) => { agent: Agent };
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
}

/** TUI 会话循环：挂载渲染 + interact 主循环；返回 /session 切换或 /connect 重建信号 */
export async function runTui(options: TuiLoopOptions): Promise<{ switchTo?: string; reconfigure?: boolean } | undefined> {
  const { store, session, modelLabel } = options;
  const hooks: HookBusType = options.hooks ?? new HookBus();
  const [state, setState] = createStore<TuiState>(initState(session.getMessages()));

  let agent: Agent;
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
    if (command === "/compact") {
      if (state.status === "running") {
        showToast("运行中不可压缩，等本轮结束后再试");
        commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 }, candidate: undefined });
        return;
      }
      commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 }, candidate: undefined });
      void compactAsync().catch(() => undefined);
      return;
    }
    if (command === "/help") {
      showToast("命令：/exit 退出 · /compact 压缩 · /session 切换 · /connect 连接 · /model 模型 · /rename 改名 · /clear 清空 · /help 帮助 · Esc 打断（连按两次退出）");
      commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 }, candidate: undefined });
      return;
    }
    if (command === "/session") {
      commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 }, candidate: undefined });
      void openSessionModal().catch(() => undefined);
      return;
    }
    if (command === "/connect") {
      // 运行中拒绝（重建链会把当前回合作废）；否则打开供应商选择弹窗
      if (state.status === "running") {
        showToast("运行中不可切换供应商，等本轮结束后再试");
        commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 }, candidate: undefined });
        return;
      }
      commit({
        ...state,
        modal: {
          kind: "connect",
          providers: PROVIDER_PRESETS.map((p) => ({ id: p.id, name: p.name, defaultModel: p.defaultModel })),
          selected: 0,
        },
        prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 },
        candidate: undefined,
      });
      return;
    }
    if (command === "/model") {
      // 显示当前配置的模型列表：↑↓ 选模型、←→ 调思考等级、Enter 应用（运行中同样等本轮结束）
      if (state.status === "running") {
        showToast("运行中不可切换模型，等本轮结束后再试");
        commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 }, candidate: undefined });
        return;
      }
      const models = options.modelList ?? [];
      const current = session.meta.model;
      const selected = Math.max(0, models.findIndex((m) => m.id === current));
      commit({
        ...state,
        modal: { kind: "model", models, selected, thinkingLevel: state.thinkingLevel },
        prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 },
        candidate: undefined,
      });
      return;
    }
    if (command === "/rename" || command.startsWith("/rename ")) {
      // /rename 会话名：改会话标题并落盘（复用现有 API：meta 可变 + rewriteMessages 持久化）
      const title = command.slice("/rename".length).trim();
      if (!title) {
        showToast("用法：/rename 会话名");
      } else {
        session.meta.title = title;
        void store
          .rewriteMessages(session, session.getMessages())
          .then(() => showToast(`会话已重命名：${title}`))
          .catch(() => showToast("重命名失败：写入会话文件出错"));
      }
      commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 }, candidate: undefined });
      return;
    }
    if (command === "/clear") {
      // 运行守卫：运行中清屏会抹掉当前回合用户消息块与进行中的工具卡，破坏视图连续性
      if (state.status === "running") {
        showToast("运行中不可清空，等本轮结束后再试");
        commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 }, candidate: undefined });
        return;
      }
      // 清空消息区（新的一屏），历史仍在会话文件里可 /session 找回
      commit({ ...state, blocks: [], streaming: undefined, toast: undefined, modal: undefined, candidate: undefined, focusIndex: -1 });
      showToast("界面已清空");
      return;
    }
    showToast(`未知命令 ${command}（/help 查看可用命令）`);
    commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 }, candidate: undefined });
  };

  /** /connect 关键一步：读输入区内容作 API Key → 写全局 config + 项目 .env；成功则请求装配层重建会话 */
  const submitConnectKey = async (): Promise<void> => {
    const conn = state.connect;
    if (!conn) return;
    const preset = PROVIDER_PRESETS.find((p) => p.id === conn.providerId);
    if (!preset) return;
    const key = state.prompt.lines.join("\n").trim();
    const result = await connectProvider(preset, key);
    // await 期间用户可能已按 Esc 取消（connect 置空）：取消后不再重建、不再动输入
    if (!state.connect) return;
    if (result.ok) {
      showToast(`${conn.providerName} 已连接，正在重建会话…`);
      pendingReconfigure = true;
      pendingSwitch = NEW_SESSION_ID;
      exitLoop();
      return;
    }
    showToast(result.error ?? "连接失败");
    commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 } });
  };

  /** /compact：强制压缩 + 历史重写落盘 */
  const compactAsync = async (): Promise<void> => {
    if (await agent.compactNow()) {
      await store.rewriteMessages(session, agent.getMessages());
      agent.consumeHistoryRewritten();
      showToast("会话历史已压缩，关键上下文已保留");
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
        sessions: sessions.map((s) => ({ id: s.id, model: s.model, updatedAt: s.updatedAt })),
        selected: 0,
      },
    });
  };

  const exitLoop = (): void => {
    runningLoop = false;
    wake?.();
    wake = undefined;
  };

  /** 打断当前轮：中断 agent + 拒绝待批权限 + 忽略迟到增量 + 界面收尾（运行态 Esc 走这里） */
  const doInterrupt = (): void => {
    agent.interrupt();
    resolvePermission("deny", "用户打断");
    ignoreStream = true;
    commit(interruptTurn(state));
    lastEscAt = 0;
  };

  /** 键盘/动作 → reducer + 副作用（App onAction 接这里） */
  const handleAction = (action: TuiAction): void => {
    switch (action.type) {
      case "send": {
        // /connect 输入态：Enter 提交 API Key（不发送给模型）
        if (state.connect) {
          void submitConnectKey();
          return;
        }
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
      case "modal-confirm": {
        if (state.modal) {
          if (state.modal.kind === "permission") {
            const option = ["allow", "allow-all", "deny"][state.modal.selected] as "allow" | "allow-all" | "deny";
            resolvePermission(option);
          } else if (state.modal.kind === "connect") {
            // 选定供应商 → 关弹窗进入 key 输入态（输入区输 key，Enter 确认）
            const connModal = state.modal;
            const preset = PROVIDER_PRESETS.find((p) => p.id === connModal.providers[connModal.selected]?.id);
            if (preset) {
              commit({
                ...state,
                modal: undefined,
                connect: {
                  providerId: preset.id,
                  providerName: preset.name,
                  apiKeyEnv: preset.apiKeyEnv,
                  defaultModel: preset.defaultModel,
                },
                prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 },
                candidate: undefined,
              });
            }
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
          } else {
            // /session 会话面板：选中切换目标后退出循环由装配层重建
            const targetIndex = state.modal.selected;
            pendingSwitch =
              targetIndex < state.modal.sessions.length
                ? state.modal.sessions[targetIndex]!.id
                : NEW_SESSION_ID;
            exitLoop();
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
          } else {
            const max = state.modal.sessions.length;
            commit({ ...state, modal: { ...state.modal, selected: Math.max(0, Math.min(max, state.modal.selected + action.dir)) } });
          }
        } else {
          commit(reduceAction(state, action));
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
        // /connect 输入态 Esc = 取消连接
        if (state.connect) {
          commit({ ...state, connect: undefined, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 } });
          return;
        }
        // Esc：有折叠聚焦先取消聚焦；运行中打断；空闲第一次 arm、窗口内第二次退出（decideEsc 纯判定）
        const verdict = decideEsc({
          hasFocus: state.focusIndex >= 0,
          running: state.status === "running",
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
              ? "自动放行（保留危险命令检查）"
              : "正常审批";
        showToast(`权限模式：${permissionModeLabel(next)}（${note}）`);
        return;
      }
      case "thinking-adjust": {
        // /model 弹窗 ←→：循环思考等级（默认→low→medium→high），同步盒子即时生效
        if (state.modal?.kind !== "model") return;
        const next = cycleThinkingLevel(state.modal.thinkingLevel);
        thinkingBox.value = next;
        commit({ ...state, modal: { ...state.modal, thinkingLevel: next } });
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

  await render(
    () => <App state={state} model={modelLabel} sessionId={session.meta.id} onAction={handleAction} />,
    renderer,
  );

  // 通道就绪：入口层装配 agent（approver/feedRoot/hooks 注入权限管线与双渲染流）
  ({ agent } = options.assemble({ approver, feedRoot, hooks }));

  // 订阅 Hook 事件渲染（会话/工具/子 agent）都进同一 reducer
  const unsubscribeHooks = [
    hooks.on("UserPromptSubmit", (e) => {
      ignoreStream = false;
      commit(reduceHook(state, e));
    }),
    hooks.on("PreToolUse", (e) => commit(reduceHook(state, e))),
    hooks.on("PostToolUse", (e) => commit(reduceHook(state, e))),
    hooks.on("PostToolUseFailure", (e) => commit(reduceHook(state, e))),
    hooks.on("AgentSpawned", (e) => commit(reduceHook(state, e))),
    hooks.on("AgentCompleted", (e) => commit(reduceHook(state, e))),
    hooks.on("AgentInterrupted", (e) => commit(reduceHook(state, e))),
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
              text: `⚠ ${error}`,
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
  }
  return pendingSwitch ? { switchTo: pendingSwitch, reconfigure: pendingReconfigure } : undefined;
}