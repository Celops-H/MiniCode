/**
 * 界面状态（纯函数核心）：事件/动作 → 界面状态。
 * 消息区由有序「块」组成（消息/工具卡片/子 agent 活动）；输入框多行编辑（上限 20 行）、
 * 历史回溯、slash 命令候选；帧生成（resolve）只读这些状态。
 */
import type { Message } from "../core/index.js";
import type { StreamEvent } from "../core/index.js";
import type { HookEvent } from "../hooks/index.js";
import type { TuiAction } from "./keymap.js";
import type { PermissionMode } from "../permission/index.js";
import type { ThinkingLevel } from "../core/index.js";

/** 消息块：用户/助手文本，思考折叠保存于 thinkingCollapsed（默认收起一行） */
export interface MessageBlock {
  kind: "message";
  id: string;
  role: "user" | "assistant";
  source?: "human" | "system";
  text: string;
  thinking?: string;
  thinkingCollapsed: boolean;
  time?: string;
  isError?: boolean;
}

/** 工具调用卡片：toolcall_* 事件创建并累积参数，PreToolUse 进执行态，PostToolUse 定成败 */
export interface ToolBlock {
  kind: "tool";
  index: number;
  /** 所属回合（done 递增的回合计数）：跨回合 index 复用区分，防残留卡被新调用误配 */
  turn: number;
  id?: string;
  name?: string;
  args: string;
  status: "pending" | "running" | "success" | "failure";
  output?: string;
  error?: string;
  collapsedArgs: boolean;
  collapsedOutput: boolean;
}

/** 子 agent 活动行（派生/完成/中断，带结论与合并结果） */
export interface AgentActivityBlock {
  kind: "agent";
  event: "spawned" | "completed" | "interrupted";
  path: string;
  conclusion?: string;
  mergeResult?: string;
}

/** 系统通知行（模型路由切换等观察事件）：常驻消息区让用户看到发生了什么（非一闪而过的 toast） */
export interface NoticeBlock {
  kind: "notice";
  id: string;
  text: string;
  time?: string;
}

export type BlockView = MessageBlock | ToolBlock | AgentActivityBlock | NoticeBlock;

/** 输入行上限（UI-SPEC §1：多行输入最多 20 行，超出不再增高，靠光标移动查看） */
export const MAX_PROMPT_LINES = 20;

/** 输入框状态：多行编辑（行上限 20）+ 历史回溯 */
export interface PromptState {
  lines: string[];
  /** 光标所在行 */
  curLine: number;
  /** 光标在该行的字符偏移（按码点数；渲染时按展示宽度换算列） */
  curCol: number;
  history: string[];
  /** -1 = 不在历史浏览中；否则浏览的 history 下标 */
  historyIndex: number;
}

/** slash 命令候选：输入首字符为 / 时弹出 */
export interface SlashCandidate {
  query: string;
  items: string[];
  selected: number;
}

/** 权限确认弹块（嵌入占位，非浮层）：三决策当前选中项用 selected 表示 */
export interface PermissionModalState {
  kind: "permission";
  toolName: string;
  /** 命令原文（bash 类工具；无则参数 JSON） */
  content?: string;
  /** 参数展示原文 */
  argsText: string;
  selected: number;
}

/** 会话切换面板：最近会话列表 + 新建入口（选中项 = 下标，新建占末位） */
export interface SessionModalState {
  kind: "session";
  sessions: Array<{ id: string; model: string; updatedAt: string }>;
  selected: number;
}

/** /connect 供应商选择弹窗：可选供应商列表（选中后留在弹窗进入 key 输入态，见 connect-key） */
export interface ConnectPickModalState {
  kind: "connect";
  providers: Array<{ id: string; name: string; defaultModel: string }>;
  selected: number;
}

/** /connect key 输入弹窗：选定供应商后弹窗内输 API Key（Enter 确认 / Esc 取消，reducer 增删 key） */
export interface ConnectKeyModalState {
  kind: "connect-key";
  providerId: string;
  providerName: string;
  apiKeyEnv: string;
  defaultModel: string;
  key: string;
}

/** /model 模型选择弹窗：列出全部配置模型（↑↓ 选模型、←→ 调思考等级），Enter 应用 */
export interface ModelModalState {
  kind: "model";
  models: Array<{ id: string }>;
  selected: number;
  thinkingLevel: ThinkingLevel | undefined;
}

/** 会话面板「新建会话」条目：选中返回的 switchTo 标记 */
export const NEW_SESSION_ID = "__new__";

/** 思考等级循环序（/model 左右调整）：low → medium → high → 缺省 → low */
export const THINKING_LEVELS: Array<ThinkingLevel | undefined> = [undefined, "low", "medium", "high"];

/** 下一个思考等级（纯函数） */
export function cycleThinkingLevel(level: ThinkingLevel | undefined): ThinkingLevel | undefined {
  const idx = THINKING_LEVELS.indexOf(level);
  return THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length];
}

/** 思考等级显示名（缺省显示「厂商默认」） */
export function thinkingLevelLabel(level: ThinkingLevel | undefined): string {
  return level ?? "默认";
}

/** 嵌入弹层：权限确认 / 会话切换 / /connect 选供应商与输 key / /model 选模型 */
export type ModalState =
  | PermissionModalState
  | SessionModalState
  | ConnectPickModalState
  | ConnectKeyModalState
  | ModelModalState;

/** 权限三决策文案（UI-SPEC §4：1/2/3 数字键选择，与 selected 对应） */
export const PERMISSION_OPTIONS = [
  { key: "1", label: "允许本次", decision: "allow" },
  { key: "2", label: "允许会话全部", decision: "allow-all" },
  { key: "3", label: "拒绝", decision: "deny" },
] as const;

/** 内置 slash 命令（输入 / 时候选加载） */
export const COMMANDS = ["/clear", "/compact", "/connect", "/exit", "/help", "/model", "/rename", "/session"] as const;

/** 权限模式循环序（Shift+Tab 切换）：一般(正常审批) → plan(只读放行) → auto(自动放行) → 一般 */
export const PERMISSION_MODES: PermissionMode[] = ["default", "plan", "bypassPermissions"];

/** 下一个权限模式（纯函数，shortcut 用） */
export function cyclePermissionMode(mode: PermissionMode): PermissionMode {
  const idx = PERMISSION_MODES.indexOf(mode);
  return PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]!;
}

/** 权限模式显示名：default / plan mode / auto mode（P3 用户定稿；后端枚举不变 default/plan/bypassPermissions） */
export function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "plan") return "plan mode";
  if (mode === "bypassPermissions") return "auto mode";
  return "default";
}

/** 当前轮流式累积区：done 时并入消息块 */
export interface Streaming {
  text: string;
  thinking: string;
  isError: boolean;
}

export interface TuiState {
  blocks: BlockView[];
  prompt: PromptState;
  streaming: Streaming | undefined;
  status: "idle" | "running";
  /** 当前权限模式（一般/plan/auto）：Shift+Tab 切换，回灌后端 PermissionPipeline */
  permissionMode: PermissionMode;
  /** 思考等级（/@/model 左右调整）：undefined=厂商默认；活引用透传 reasoning_effort（仅支持的厂商） */
  thinkingLevel: ThinkingLevel | undefined;
  /** 可见 agent 路径列表（main() 恒在首位，AgentSpawned 追加）——底栏 agent 树数据源 */
  agents: string[];
  /** 消息区上滚行数：0 跟随底部，>0 用户上滚 */
  scrollOffset: number;
  /** 可折叠块聚焦（Tab 切换、Enter 翻折）：-1 无聚焦（Enter 发送） */
  focusIndex: number;
  toast?: { text: string; key: number };
  /** slash 命令候选（输入以 / 开头时出现） */
  candidate?: SlashCandidate;
  /** 嵌入弹层（权限确认 / 会话切换 / /connect / /model）：出现时输入禁用、消息区让位 */
  modal?: ModalState;
  /** 回合计数：done 递增，工具卡片按它隔离所属回合 */
  turnIndex: number;
}

/**
 * 全新空输入态（每次新建：不共享模块常量数组）。共享引用会让 solid reconcile 把 lines 更新
 * 当成「引用未变」而跳过 —— 表现即「发送后输入框不清空」（历史 bug，见 2026-08-26 定位）。
 */
function emptyPrompt(history: string[]): PromptState {
  return { lines: [""], curLine: 0, curCol: 0, history, historyIndex: -1 };
}

/** 展示时间：HH:MM:SS */
export function formatTime(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 模型调用失败的可读提示：识别认证/配置类错误追加「换模型/配 key」引导，其它错误保持原样。
 *  覆盖切到无 API Key 模型、key 无效（401/403）、模型 id 无效（404/未找到/未知模型）场景——
 *  错误入口统一（interact catch 与 reduceEvent error）都套它，避免 SDK 原文裸抛看不懂。 */
export function modelErrorText(error: string): string {
  const markers = [
    "未配置认证",
    "请设置环境变量",
    "未知模型",
    "401",
    "403",
    "404",
    "does not exist",
    "not found",
    "Incorrect API key",
    "api key",
    "authentication",
  ] as const;
  if (markers.some((m) => error.toLowerCase().includes(m.toLowerCase()))) {
    return `${error}\n可用 /model 换模型，或 /connect 连接厂商配置 API Key`;
  }
  return error;
}

/** 输入框首行文本（判断 / 命令与候选依据） */
export function promptFirstLine(prompt: PromptState): string {
  return prompt.lines[0] ?? "";
}

/** 输入是否为空（发送判定、方向键是否回溯历史） */
export function promptEmpty(prompt: PromptState): boolean {
  return prompt.lines.every((l) => l.length === 0) && prompt.lines.length === 1;
}

/** 历史消息 → 初始块序列（工具调用配工具结果卡片，缺结果的标 pending） */
export function initState(messages: Message[]): TuiState {
  const blocks: BlockView[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      blocks.push({
        kind: "message",
        id: message.id,
        role: "user",
        source: message.source,
        text: message.content,
        thinkingCollapsed: true,
      });
    } else if (message.role === "assistant") {
      const text = message.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      const thinking = message.content
        .filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking")
        .map((b) => b.thinking)
        .join("");
      if (text || thinking) {
        blocks.push({
          kind: "message",
          id: message.id,
          role: "assistant",
          text,
          thinking: thinking || undefined,
          thinkingCollapsed: true,
        });
      }
      for (const call of message.content.filter(
        (b): b is { type: "tool_call"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_call",
      )) {
        blocks.push({
          kind: "tool",
          index: blocks.length,
          turn: 0,
          id: call.id,
          name: call.name,
          args: JSON.stringify(call.input ?? {}),
          status: "pending",
          collapsedArgs: true,
          collapsedOutput: true,
        });
      }
    } else if (message.role === "tool_result") {
      const card = findToolById(blocks, message.toolCallId);
      if (card) {
        card.status = message.isError ? "failure" : "success";
        card.error = message.isError ? message.content : undefined;
        card.output = message.isError ? undefined : message.content;
      }
    }
  }
  return {
    blocks,
    prompt: emptyPrompt([]),
    streaming: undefined,
    status: "idle",
    permissionMode: "default",
    thinkingLevel: undefined,
    agents: ["/root"],
    scrollOffset: 0,
    turnIndex: 0,
    focusIndex: -1,
  };
}

/** 是否有可折叠内容（思考折叠 / 工具参数与输出折叠）；导出供 loop 空输入展开交互复用 */
export function isFoldable(block: BlockView): boolean {
  if (block.kind === "message") return Boolean(block.thinking);
  if (block.kind === "tool") return Boolean(block.args) || Boolean(block.output || block.error);
  return false;
}

/** 翻转一个可折叠块的折叠态（消息翻思考，工具翻参数与输出） */
function flipFold(block: BlockView): BlockView {
  if (block.kind === "message") return { ...block, thinkingCollapsed: !block.thinkingCollapsed };
  if (block.kind === "tool") return { ...block, collapsedArgs: !block.collapsedArgs, collapsedOutput: !block.collapsedOutput };
  return block;
}

/** 按 toolCallId 找工具卡片（历史配对用，最近一个） */
function findToolById(blocks: BlockView[], id: string): ToolBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "tool" && block.id === id) return block;
  }
  return undefined;
}

/** 指定回合进行中（pending/running）的最后一个工具卡片 */
function findActiveTool(blocks: BlockView[], index: number, turn: number): ToolBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (
      block.kind === "tool" &&
      block.index === index &&
      block.turn === turn &&
      (block.status === "pending" || block.status === "running")
    ) {
      return block;
    }
  }
  return undefined;
}

/** 最近一个尚未配对的工具卡片（PreToolUse 调用 id 先于卡片存在时兜底） */
function findPendingTool(blocks: BlockView[]): ToolBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "tool" && block.id === undefined && block.status === "pending") return block;
  }
  return undefined;
}

/** StreamEvent → 状态（文本流式 / 工具调用卡片 / 轮边界） */
export function reduceEvent(state: TuiState, event: StreamEvent): TuiState {
  switch (event.type) {
    case "text_delta": {
      const prev = state.streaming;
      return {
        ...state,
        streaming: {
          text: (prev?.text ?? "") + event.text,
          thinking: prev?.thinking ?? "",
          isError: prev?.isError ?? false,
        },
        status: "running",
      };
    }
    case "thinking_delta": {
      const prev = state.streaming;
      return {
        ...state,
        streaming: {
          text: prev?.text ?? "",
          thinking: (prev?.thinking ?? "") + event.thinking,
          isError: prev?.isError ?? false,
        },
        status: "running",
      };
    }
    case "toolcall_start": {
      const active = findActiveTool(state.blocks, event.index, state.turnIndex);
      if (active) {
        // 后端补发 id/name 时重复发 start：原地更新该卡（不可变替换）
        const blocks = state.blocks.map((b) =>
          b === active ? { ...b, id: event.id ?? b.id, name: event.name ?? b.name } : b,
        );
        return { ...state, blocks };
      }
      const tool: ToolBlock = {
        kind: "tool",
        index: event.index,
        turn: state.turnIndex,
        id: event.id,
        name: event.name,
        args: "",
        status: "pending",
        collapsedArgs: true,
        collapsedOutput: true,
      };
      return { ...state, blocks: [...state.blocks, tool], status: "running" };
    }
    case "toolcall_delta": {
      const active = findActiveTool(state.blocks, event.index, state.turnIndex);
      if (!active) return state;
      const blocks = state.blocks.map((b) => (b === active ? { ...b, args: b.args + event.partialJson } : b));
      return { ...state, blocks };
    }
    case "toolcall_end":
      return { ...state };
    case "done": {
      const hasContent = Boolean(state.streaming && (state.streaming.text || state.streaming.thinking));
      const merged = hasContent && state.streaming
        ? appendMessageBlock(state, {
            id: `turn_${state.blocks.length}`,
            role: "assistant",
            text: state.streaming.text,
            thinking: state.streaming.thinking || undefined,
            isError: state.streaming.isError,
            time: formatTime(),
          })
        : state;
      const status: "idle" | "running" =
      event.stopReason === "tool_use" || event.stopReason === "tool_calls" ? "running" : "idle";
      return { ...merged, streaming: undefined, status, scrollOffset: 0, turnIndex: state.turnIndex + 1 };
    }
    case "error": {
      if (!state.streaming || (!state.streaming.text && !state.streaming.thinking)) {
        // 无前缀内容的独立错误：展示错误消息块并回到空闲（error 即轮边界）；
        // 与 interact catch 同一套 modelErrorText，模型类错误带换模型/配 key 引导
        return {
          ...state,
          streaming: undefined,
          status: "idle",
          blocks: [
            ...state.blocks,
            {
              kind: "message",
              id: `err_${state.blocks.length}`,
              role: "assistant",
              text: modelErrorText(event.message),
              isError: true,
              time: formatTime(),
              thinkingCollapsed: true,
            },
          ],
        };
      }
      return { ...state, streaming: { ...state.streaming, isError: true } };
    }
    case "model_fallback":
      // 模型路由切换观察事件：追加常驻通知行（主模型不可用自动切备选），消息列表展示而非一闪而过
      return {
        ...state,
        blocks: [
          ...state.blocks,
          {
            kind: "notice",
            id: `notice_${state.blocks.length}`,
            text: `模型 ${event.from} 不可用，已切换 ${event.to}`,
            time: formatTime(),
          },
        ],
      };
    default:
      return state;
  }
}

/** 打断当前轮（Ctrl+C）：已产出的半截文本保留为消息块，未闭合的工具卡标中断失败，回空闲。
 *  后端中断收尾不发 done/error（契约约定），视图在此自行收尾防跨回合误配。 */
export function interruptTurn(state: TuiState): TuiState {
  const blocks = [...state.blocks];
  if (state.streaming?.text || state.streaming?.thinking) {
    blocks.push({
      kind: "message",
      id: `turn_${blocks.length}`,
      role: "assistant",
      text: state.streaming.text,
      thinking: state.streaming.thinking || undefined,
      thinkingCollapsed: true,
      time: formatTime(),
    });
  }
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.kind === "tool" && (block.status === "pending" || block.status === "running")) {
      blocks[i] = { ...block, status: "failure", error: "执行中断：用户打断" };
    }
  }
  return { ...state, blocks, streaming: undefined, status: "idle" };
}

/** 追加消息块 */
function appendMessageBlock(
  state: TuiState,
  block: Omit<MessageBlock, "kind" | "thinkingCollapsed">,
): TuiState {
  return {
    ...state,
    blocks: [...state.blocks, { ...block, kind: "message", thinkingCollapsed: true }],
  };
}

/** HookEvent → 状态（用户输入 / 工具生命周期 / 子 agent 活动 / 会话边界） */
export function reduceHook(state: TuiState, event: HookEvent): TuiState {
  switch (event.type) {
    case "UserPromptSubmit":
      return {
        ...state,
        streaming: undefined,
        blocks: [
          ...state.blocks,
          {
            kind: "message",
            id: `user_${state.blocks.length}`,
            role: "user",
            text: event.input,
            time: formatTime(),
            thinkingCollapsed: true,
          },
        ],
        status: "running",
      };
    case "PreToolUse": {
      const card = findToolById(state.blocks, event.toolCallId) ?? findPendingTool(state.blocks);
      const blocks = card
        ? state.blocks.map((b) =>
            b === card ? { ...b, status: "running" as const, name: event.toolName || b.name } : b,
          )
        : [
            ...state.blocks,
            {
              kind: "tool",
              index: state.blocks.length,
              turn: state.turnIndex,
              id: event.toolCallId,
              name: event.toolName,
              args: JSON.stringify(event.input ?? {}),
              status: "running",
              collapsedArgs: true,
              collapsedOutput: true,
            } as ToolBlock,
          ];
      return { ...state, blocks, status: "running" };
    }
    case "PostToolUse": {
      const card = findToolById(state.blocks, event.toolCallId);
      if (!card) return state;
      const blocks = state.blocks.map((b) =>
        b === card
          ? {
              ...b,
              // 执行完成但 isError 标记（如超时/被杀）：按失败显示（✕），不伪装成功
              status: (event.isError ? "failure" : "success") as "failure" | "success",
              output: event.isError ? undefined : event.output,
              error: event.isError ? event.output : undefined,
            }
          : b,
      );
      return { ...state, blocks };
    }
    case "PostToolUseFailure": {
      const card = findToolById(state.blocks, event.toolCallId);
      if (!card) return state;
      const blocks = state.blocks.map((b) =>
        b === card ? { ...b, status: "failure" as const, error: event.error, output: undefined } : b,
      );
      return { ...state, blocks };
    }
    case "AgentSpawned":
      return {
        ...state,
        agents: state.agents.includes(event.path) ? state.agents : [...state.agents, event.path],
        blocks: [...state.blocks, { kind: "agent", event: "spawned", path: event.path }],
      };
    case "AgentCompleted":
      return {
        ...state,
        blocks: [
          ...state.blocks,
          {
            kind: "agent",
            event: "completed",
            path: event.path,
            conclusion: event.conclusion,
            mergeResult: event.mergeResult,
          },
        ],
      };
    case "AgentInterrupted":
      return {
        ...state,
        blocks: [...state.blocks, { kind: "agent", event: "interrupted", path: event.path }],
      };
    case "Stop":
      return { ...state, status: "idle" };
    default:
      return state;
  }
}

/** 按输入前缀重算 slash 候选（当前项尽量保持选中，无匹配按首个） */
function recomputeCandidate(prompt: PromptState, previous?: SlashCandidate): SlashCandidate | undefined {
  const query = promptFirstLine(prompt);
  if (!query.startsWith("/")) return undefined;
  const items = COMMANDS.filter((c) => c.startsWith(query));
  if (items.length === 0) return undefined;
  const keep = previous ? previous.items[previous.selected] : undefined;
  const keepIndex = keep ? items.findIndex((c) => c === keep) : -1;
  return { query, items, selected: keepIndex >= 0 ? keepIndex : 0 };
}

/** 用户动作 → 状态（发送/中断等副作用由 loop 层落地） */
export function reduceAction(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "input": {
      // /connect key 弹窗输入态：字符进弹窗内 key 缓冲，不进输入框
      if (state.modal?.kind === "connect-key") {
        return { ...state, modal: { ...state.modal, key: state.modal.key + action.text } };
      }
      // 单字符插入（IME 上送的成串字符也一次插入，不含换行）
      const prompt = insertText(state.prompt, action.text);
      return {
        ...state,
        prompt,
        candidate: recomputeCandidate(prompt, state.candidate),
      };
    }
    case "newline": {
      if (state.prompt.lines.length >= MAX_PROMPT_LINES) return state;
      const prompt = splitLine(state.prompt);
      return { ...state, prompt, candidate: recomputeCandidate(prompt, state.candidate) };
    }
    case "backspace": {
      // /connect key 弹窗输入态：删除 key 缓冲末字符
      if (state.modal?.kind === "connect-key") {
        return {
          ...state,
          modal: { ...state.modal, key: Array.from(state.modal.key).slice(0, -1).join("") },
        };
      }
      const prompt = deleteBackward(state.prompt);
      return { ...state, prompt, candidate: recomputeCandidate(prompt, state.candidate) };
    }
    case "delete": {
      const prompt = deleteForward(state.prompt);
      return { ...state, prompt, candidate: recomputeCandidate(prompt, state.candidate) };
    }
    case "cursor": {
      return { ...state, prompt: moveCursor(state.prompt, action.dir) };
    }
    case "history": {
      // 历史回溯：不在浏览时 ↑ 进最后一条；浏览中 ↑/↓ 移动；-1 退出浏览回编辑内容
      const history = state.prompt.history;
      if (history.length === 0) return state;
      const browsing = state.prompt.historyIndex !== -1;
      const nextIndex = browsing ? state.prompt.historyIndex + action.dir : action.dir === -1 ? history.length - 1 : -1;
      if (nextIndex >= history.length) return state; // 已在最旧一条再 ↓
      const prompt: PromptState =
        nextIndex === -1
          ? { ...state.prompt, historyIndex: -1 }
          : (() => {
              const lines = history[nextIndex]!.split("\n");
              const last = lines.at(-1) ?? "";
              return {
                lines,
                curLine: lines.length - 1,
                curCol: Array.from(last).length,
                history,
                historyIndex: nextIndex,
              };
            })();
      return { ...state, prompt };
    }
    case "complete": {
      // slash 候选 Tab 补全：把当前选中项填入输入首行
      if (!state.candidate) return state;
      const item = state.candidate.items[state.candidate.selected];
      if (!item) return state;
      const prompt: PromptState = {
        ...state.prompt,
        lines: [item, ...state.prompt.lines.slice(1)],
        curLine: 0,
        curCol: item.length,
      };
      return { ...state, prompt, candidate: recomputeCandidate(prompt, state.candidate) };
    }
    case "modal-nav": {
      if (!state.candidate) return { ...state, prompt: moveCursor(state.prompt, action.dir === -1 ? "up" : "down") };
      const selected = Math.max(0, Math.min(state.candidate.items.length - 1, state.candidate.selected + action.dir));
      return { ...state, candidate: { ...state.candidate, selected } };
    }
    case "toggle-focus": {
      // 在可折叠块间移动聚焦（Tab 高亮当前块，供键盘用户定位）
      const foldables = state.blocks.map((b, i): number => (isFoldable(b) ? i : -1)).filter((i) => i >= 0);
      if (foldables.length === 0) return state;
      const current = state.focusIndex;
      const next = current >= 0 ? foldables.find((i) => i > current) : foldables[0];
      return { ...state, focusIndex: next ?? current };
    }
    case "fold-at": {
      // 鼠标左键点折叠块任意部位：直接翻转指定块的折叠态（无论聚焦与否）
      const target = state.blocks[action.index];
      if (!target || !isFoldable(target)) return state;
      const blocks = state.blocks.map((b, i) => (i === action.index ? flipFold(b) : b));
      return { ...state, blocks };
    }
    case "cancel":
      // 依次收起：聚焦 → slash 候选
      if (state.focusIndex >= 0) return { ...state, focusIndex: -1 };
      return { ...state, candidate: undefined };
    case "send": {
      // 发送：输入记入历史供回溯，输入框清空进入运行态（空 prompt 用 fresh lines，见 emptyPrompt）
      const sent = state.prompt.lines.join("\n").trim();
      const history = sent ? [...state.prompt.history, sent] : state.prompt.history;
      return {
        ...state,
        prompt: emptyPrompt(history),
        status: "running",
        candidate: undefined,
      };
    }
    case "clear-input":
      return { ...state, prompt: emptyPrompt(state.prompt.history), candidate: undefined };
    case "scroll":
      return { ...state, scrollOffset: Math.max(0, state.scrollOffset + action.dir) };
    case "scroll-end":
      return { ...state, scrollOffset: 0 };
    case "interrupt":
    case "exit":
    case "permission":
    case "modal-confirm":
    case "esc":
    case "mode-cycle":
    case "thinking-adjust":
    case "noop":
      return state;
  }
}

/** 输入框单字符插入 */
function insertText(prompt: PromptState, text: string): PromptState {
  const line = prompt.lines[prompt.curLine] ?? "";
  const before = Array.from(line).slice(0, prompt.curCol).join("");
  const after = Array.from(line).slice(prompt.curCol).join("");
  const lines = [...prompt.lines];
  lines[prompt.curLine] = before + text + after;
  return { ...prompt, lines, curCol: prompt.curCol + Array.from(text).length };
}

/** 光标处换行（超 20 行忽略） */
function splitLine(prompt: PromptState): PromptState {
  const line = prompt.lines[prompt.curLine] ?? "";
  const before = Array.from(line).slice(0, prompt.curCol).join("");
  const after = Array.from(line).slice(prompt.curCol).join("");
  const lines = [...prompt.lines.slice(0, prompt.curLine), before, after, ...prompt.lines.slice(prompt.curLine + 1)];
  return { ...prompt, lines, curLine: prompt.curLine + 1, curCol: 0 };
}

/** 退格：删光标前字符；行首时与上一行合并 */
function deleteBackward(prompt: PromptState): PromptState {
  const line = prompt.lines[prompt.curLine] ?? "";
  if (prompt.curCol > 0) {
    const chars = Array.from(line);
    const before = chars.slice(0, prompt.curCol - 1).join("");
    const after = chars.slice(prompt.curCol).join("");
    const lines = [...prompt.lines];
    lines[prompt.curLine] = before + after;
    return { ...prompt, lines, curCol: prompt.curCol - 1 };
  }
  if (prompt.curLine === 0) return prompt;
  const prev = prompt.lines[prompt.curLine - 1] ?? "";
  const lines = [...prompt.lines.slice(0, prompt.curLine - 1), prev + line, ...prompt.lines.slice(prompt.curLine + 1)];
  return { ...prompt, lines, curLine: prompt.curLine - 1, curCol: Array.from(prev).length };
}

/** 删除：删光标处字符；行尾时与下一行合并 */
function deleteForward(prompt: PromptState): PromptState {
  const line = prompt.lines[prompt.curLine] ?? "";
  const chars = Array.from(line);
  if (prompt.curCol < chars.length) {
    const before = chars.slice(0, prompt.curCol).join("");
    const after = chars.slice(prompt.curCol + 1).join("");
    const lines = [...prompt.lines];
    lines[prompt.curLine] = before + after;
    return { ...prompt, lines };
  }
  if (prompt.curLine >= prompt.lines.length - 1) return prompt;
  const next = prompt.lines[prompt.curLine + 1] ?? "";
  const lines = [...prompt.lines.slice(0, prompt.curLine), line + next, ...prompt.lines.slice(prompt.curLine + 2)];
  return { ...prompt, lines };
}

/** 光标移动（跨行时保持目标列到行末截断） */
function moveCursor(prompt: PromptState, dir: "left" | "right" | "up" | "down"): PromptState {
  const line = prompt.lines[prompt.curLine] ?? "";
  const colCount = Array.from(line).length;
  switch (dir) {
    case "left": {
      if (prompt.curCol > 0) return { ...prompt, curCol: prompt.curCol - 1 };
      if (prompt.curLine === 0) return prompt;
      const prev = prompt.lines[prompt.curLine - 1] ?? "";
      return { ...prompt, curLine: prompt.curLine - 1, curCol: Array.from(prev).length };
    }
    case "right": {
      if (prompt.curCol < colCount) return { ...prompt, curCol: prompt.curCol + 1 };
      if (prompt.curLine >= prompt.lines.length - 1) return prompt;
      return { ...prompt, curLine: prompt.curLine + 1, curCol: 0 };
    }
    case "up": {
      if (prompt.curLine === 0) return prompt;
      const prev = prompt.lines[prompt.curLine - 1] ?? "";
      return { ...prompt, curLine: prompt.curLine - 1, curCol: Math.min(prompt.curCol, Array.from(prev).length) };
    }
    case "down":
      if (prompt.curLine >= prompt.lines.length - 1) return prompt;
      const next = prompt.lines[prompt.curLine + 1] ?? "";
      return { ...prompt, curLine: prompt.curLine + 1, curCol: Math.min(prompt.curCol, Array.from(next).length) };
  }
}