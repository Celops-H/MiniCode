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
import { initState, reduceAction, reduceEvent, reduceHook, interruptTurn, formatTime, promptEmpty, isFoldable, NEW_SESSION_ID, type TuiState } from "./state.js";
import { App } from "./view/App.js";
import { interact } from "../cli/interact.js";
import { win32DisableProcessedInput, win32FlushInputBuffer } from "./win32.js";
import type { Agent } from "../agent/index.js";
import type { Session, SessionStore } from "../storage/index.js";
import { HookBus } from "../hooks/index.js";
import type { HookBus as HookBusType } from "../hooks/index.js";
import type { PermissionApprover, PermissionDecision, PermissionRequest } from "../permission/index.js";

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
}

/** TUI 会话循环：挂载渲染 + interact 主循环；返回 /session 切换信号或 undefined 正常退出 */
export async function runTui(options: TuiLoopOptions): Promise<{ switchTo?: string } | undefined> {
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
  /** 打断后忽略本回合迟到增量（后端中断收尾不发 done，残余事件丢弃） */
  let ignoreStream = false;

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
      showToast("可用命令：/exit 退出 · /compact 压缩历史 · /session 切换会话 · /help 帮助");
      commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 }, candidate: undefined });
      return;
    }
    if (command === "/session") {
      commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 }, candidate: undefined });
      void openSessionModal().catch(() => undefined);
      return;
    }
    showToast(`未知命令 ${command}（/help 查看可用命令）`);
    commit({ ...state, prompt: { ...state.prompt, lines: [""], curCol: 0, curLine: 0 }, candidate: undefined });
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

  /** 键盘/动作 → reducer + 副作用（App onAction 接这里） */
  const handleAction = (action: TuiAction): void => {
    switch (action.type) {
      case "send": {
        if (state.focusIndex >= 0 && promptEmpty(state.prompt)) {
          commit(reduceAction(state, { type: "toggle-fold" }));
          return;
        }
        if (promptEmpty(state.prompt)) {
          const lastFoldable = state.blocks
            .map((b, i): number => (isFoldable(b) ? i : -1))
            .filter((i) => i >= 0)
            .at(-1);
          if (lastFoldable !== undefined) commit(reduceAction({ ...state, focusIndex: lastFoldable }, { type: "toggle-fold" }));
          return;
        }
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
          } else {
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
      case "interrupt": {
        if (state.status === "running") {
          agent.interrupt();
          resolvePermission("deny", "用户打断");
          ignoreStream = true;
          commit(interruptTurn(state));
        } else {
          exitLoop();
        }
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
      default:
        commit(reduceAction(state, action));
    }
  };

  // Windows 终端输入初始化（opencode 同款）：清 PROCESSED_INPUT + 清缓冲，进 TUI 前调用
  win32DisableProcessedInput();
  win32FlushInputBuffer();

  // 渲染挂载（render 立即返回，渲染器持续；退出时 destroy 还原终端）。
  // exitOnCtrlC 必须 false：Ctrl+C 语义由 loop 的 interrupt/退出接管（M4.3 交互经验，非渲染器自毁）
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
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
  return pendingSwitch ? { switchTo: pendingSwitch } : undefined;
}