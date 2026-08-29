/**
 * 界面状态（纯函数核心）：事件/动作 → 界面状态。
 * 消息区由有序「块」组成（消息/工具卡片/子 agent 活动）；输入框多行编辑（上限 20 行）、
 * 历史回溯、slash 命令候选；帧生成（resolve）只读这些状态。
 */
import { COMMAND_MARKER, type Message } from "../core/index.js";
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
  source?: "human" | "system" | "command";
  /** 助手消息的实际产出模型（E18：路由切到备选后署名跟随；缺省用会话当前模型） */
  model?: string;
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

/** 子 agent 活动行（派生/完成/中断，带结论与合并结果）；collapsed 默认折叠——结论/合并长内容
 *  平时收敛成单行，点击展开（用户复核：子 agent 结果应像工具一样支持展开/关闭） */
export interface AgentActivityBlock {
  kind: "agent";
  event: "spawned" | "completed" | "interrupted";
  path: string;
  conclusion?: string;
  mergeResult?: string;
  collapsed: boolean;
}

/** 系统通知行（模型路由切换等观察事件）：常驻消息区让用户看到发生了什么（非一闪而过的 toast） */
export interface NoticeBlock {
  kind: "notice";
  id: string;
  text: string;
  time?: string;
}

/** 命令块（E24）：/init /compact 等命令的痕迹，一条命令一行——执行过程不铺屏，会话重演时按块还原 */
export interface CommandBlock {
  kind: "command";
  id: string;
  /** 命令原文（含参数，如 "/compact 侧重保留命令输出"） */
  text: string;
  time?: string;
}

export type BlockView = MessageBlock | ToolBlock | AgentActivityBlock | NoticeBlock | CommandBlock;

/** agent 树节点：路径 + 运行/完成状态；派生/完成时刻由 loop 侧注入（事件本身无时间戳），
 *  完成条目在底栏树展示 10s 后消失，耗时 = completedAt - spawnedAt */
export interface AgentNode {
  path: string;
  status: "running" | "completed" | "interrupted";
  spawnedAt: number | null;
  completedAt: number | null;
}

/** agent 生命周期 HookEvent 附带的时刻（loop 注入，state reducer 保持纯函数） */
export type AgentEventMeta = HookEvent & { spawnedAt?: number; completedAt?: number };

/** 输入行上限（UI-SPEC §1：多行输入最多 20 行，超出不再增高，靠光标移动查看） */
export const MAX_PROMPT_LINES = 20;

/** 输入框选区锚点：Shift+方向键起点（光标 curLine/curCol 是焦点端，随移动扩展/收缩） */
export interface SelectionAnchor {
  line: number;
  col: number;
}

/** 输入框状态：多行编辑（行上限 20）+ 历史回溯 + 选区（Shift 选择，B-2） */
export interface PromptState {
  lines: string[];
  /** 光标所在行 */
  curLine: number;
  /** 光标在该行的字符偏移（按码点数；渲染时按展示宽度换算列） */
  curCol: number;
  history: string[];
  /** -1 = 不在历史浏览中；否则浏览的 history 下标 */
  historyIndex: number;
  /** 选区锚点（null=无选区）；光标是焦点端，选区 = 锚点↔光标的文本 */
  sel: SelectionAnchor | null;
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

/** 会话切换面板：最近会话列表 + 新建入口（P6-4 新建置顶固定第一项并默认选中，selected 0=新建、1..n=会话；
 *  新建行不参与会话滚动区、无删除操作态）；当前活跃会话不展示（列表=切换其它会话，P4-2 防误删本会话）；
 *  选中行动作态 ←→ 切换 */
export interface SessionModalState {
  kind: "session";
  /** 会话列表（title 随 /rename 更新；sizeBytes=消息文件大小 P4-3 副行展示） */
  sessions: Array<{ id: string; title: string; model: string; updatedAt: string; sizeBytes: number }>;
  selected: number;
  /** 当前选中行的操作态：进入（缺省/默认）或删除（一步删除，P4-2；←→ 切换） */
  action?: "enter" | "delete";
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
  /** 模型列表带厂商（providerId/名称）：/model 弹窗按厂商分组展示（组头不可选中） */
  models: Array<{ id: string; providerId?: string; providerName?: string }>;
  selected: number;
  thinkingLevel: ThinkingLevel | undefined;
}

/** /mcp 与 /skill 扩展面板（UI-SPEC §8b）：行内启用/关闭 ←→ 切换（只改弹窗内候选，Esc 取消不改），
 *  Enter 应用——按「写回定义层」规则写配置并重装配，当前会话立即生效（BACKEND §19/§20 回写规则）。
 *  拆成两个单字面量 kind 变体（与各弹窗一致）：联合判别字段在 TS 取反分支不收窄，会污染 session 分支。 */
export interface ExtensionModalRow {
  /** mcp=服务名 / skill=技能名（回写定位键） */
  id: string;
  label: string;
  /** 副列：mcp=连接状态，skill=描述 */
  detail: string;
  enabled: boolean;
  /** skill 行来源层（回写落层用）；mcp 行不带 */
  source?: "project" | "user";
}

export interface McpModalState {
  kind: "mcp";
  rows: ExtensionModalRow[];
  selected: number;
}

export interface SkillModalState {
  kind: "skill";
  rows: ExtensionModalRow[];
  selected: number;
}

/** 会话面板「新建会话」条目：选中返回的 switchTo 标记 */
export const NEW_SESSION_ID = "__new__";

/** /session 面板确认目标解析（P6-4 新建置顶）：selected 0=新建会话、1..n=会话（下标 selected-1）；
 *  返回「新建」或切换目标会话 id；越界 selected 兜底为新建（防御，正常由 loop clamp）。 */
export function sessionModalTarget(
  selected: number,
  sessions: ReadonlyArray<{ id: string }>,
): { kind: "new" } | { kind: "session"; id: string } {
  if (selected >= 1 && selected <= sessions.length) return { kind: "session", id: sessions[selected - 1]!.id };
  return { kind: "new" };
}

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

/** 嵌入弹层：权限确认 / 会话切换 / /connect 选供应商与输 key / /model 选模型 / /mcp 与 /skill 扩展面板 */
export type ModalState =
  | PermissionModalState
  | SessionModalState
  | ConnectPickModalState
  | ConnectKeyModalState
  | ModelModalState
  | McpModalState
  | SkillModalState;

/** 权限三决策文案（UI-SPEC §4：1/2/3 数字键选择，与 selected 对应） */
export const PERMISSION_OPTIONS = [
  { key: "1", label: "允许本次", decision: "allow" },
  { key: "2", label: "允许会话全部", decision: "allow-all" },
  { key: "3", label: "拒绝", decision: "deny" },
] as const;

/** 内置 slash 命令（输入 / 时候选加载） */
export const COMMANDS = ["/clear", "/compact", "/connect", "/exit", "/help", "/init", "/mcp", "/model", "/rename", "/session", "/skill"] as const;

/** 权限模式循环序（Shift+Tab 切换）：default(正常审批) → plan(只读放行) → bypassPermissions(自动放行) → default */
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
  /** 会话标题（状态行显示；/rename 时同步，/session 重建时由装配层传入；空显示「新会话」） */
  title: string;
  /** 当前权限模式（default/plan/bypassPermissions）：Shift+Tab 切换，回灌后端 PermissionPipeline；显示名见 permissionModeLabel */
  permissionMode: PermissionMode;
  /** 思考等级（/@/model 左右调整）：undefined=厂商默认；活引用透传 reasoning_effort（仅支持的厂商） */
  thinkingLevel: ThinkingLevel | undefined;
  /** 本轮实际产出模型（E18）：model_fallback 事件暂存，done 落消息块时作署名并清除 */
  activeModel?: string;
  /** agent 树（/root=main 恒在首位）：路径 + 运行/完成状态 + 派生/完成时刻——底栏 agent 树数据源 */
  agents: AgentNode[];
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
  return { lines: [""], curLine: 0, curCol: 0, history, historyIndex: -1, sel: null };
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

/** 输入框选区文本（Shift 选择锚点↔光标，B-2）：按码点取区间，跨行用换行连接；无选区返回空串 */
export function selectedPromptText(p: PromptState): string {
  if (!p.sel) return "";
  const a = p.sel;
  const aBefore = a.line < p.curLine || (a.line === p.curLine && a.col <= p.curCol);
  const anchor = aBefore ? a : { line: p.curLine, col: p.curCol };
  const focus = aBefore ? { line: p.curLine, col: p.curCol } : a;
  const codepoints = (i: number): string[] => Array.from(p.lines[i] ?? "");
  if (anchor.line === focus.line) {
    return codepoints(anchor.line).slice(anchor.col, focus.col).join("");
  }
  const head = codepoints(anchor.line).slice(anchor.col).join("");
  const mid = p.lines.slice(anchor.line + 1, focus.line);
  const tail = codepoints(focus.line).slice(0, focus.col).join("");
  return [head, ...mid, tail].join("\n");
}

/** 历史消息 → 初始块序列（工具调用配工具结果卡片，缺结果的标 pending）；title 为会话标题（/rename 同步）。
 *  user/assistant 消息带创建时间戳（后端消息结构 P11）时回填发送时间，切模型等 reconfigure
 *  重建后历史消息的时间不丢（此前只有流式新消息才有 time）；非法/缺失时间戳不显示（审查补） */
export function initState(messages: Message[], title = ""): TuiState {
  const blocks: BlockView[] = [];
  const msgTime = (m: Message): string | undefined => {
    if (!m.timestamp) return undefined;
    const t = new Date(m.timestamp);
    if (Number.isNaN(t.getTime())) return undefined;
    return formatTime(t);
  };
  for (const message of messages) {
    if (message.role === "user") {
      // 命令消息重演为命令块（E24）：正文剥掉标记前缀，一条命令一行
      if (message.source === "command") {
        blocks.push({
          kind: "command",
          id: message.id,
          text: message.content.startsWith(COMMAND_MARKER)
            ? message.content.slice(COMMAND_MARKER.length)
            : message.content,
          time: msgTime(message),
        });
        continue;
      }
      blocks.push({
        kind: "message",
        id: message.id,
        role: "user",
        source: message.source,
        text: message.content,
        thinkingCollapsed: true,
        time: msgTime(message),
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
          // 署名跟随实际产出模型（E18）：无记录的历史消息回落会话当前模型
          model: message.meta?.model,
          text,
          thinking: thinking || undefined,
          thinkingCollapsed: true,
          time: msgTime(message),
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
    title,
    permissionMode: "default",
    thinkingLevel: undefined,
    agents: [{ path: "/root", status: "running", spawnedAt: null, completedAt: null }],
    scrollOffset: 0,
    turnIndex: 0,
    focusIndex: -1,
  };
}

/** /clear 回会话新建态：消息区/流式/弹层/候选/聚焦/agent 树/输入清空。
 *  会话条目与磁盘历史由调用方（loop /clear）处理：rewriteMessages([]) 清空；标题保留不复位。 */
export function resetToNewState(state: TuiState): TuiState {
  return {
    ...state,
    blocks: [],
    streaming: undefined,
    toast: undefined,
    modal: undefined,
    candidate: undefined,
    focusIndex: -1,
    agents: [{ path: "/root", status: "running", spawnedAt: null, completedAt: null }],
    prompt: emptyPrompt(state.prompt.history),
  };
}

/** 是否有可折叠内容（思考折叠 / 工具参数与输出折叠 / 子 agent 结论与合并）；导出供 loop 空输入展开交互复用 */
export function isFoldable(block: BlockView): boolean {
  if (block.kind === "message") return Boolean(block.thinking);
  if (block.kind === "tool") return Boolean(block.args) || Boolean(block.output || block.error);
  // 子 agent 有结论/合并结果才可折叠（派生/中断无内容不需折叠）
  if (block.kind === "agent") return block.event === "completed" && Boolean(block.conclusion || block.mergeResult);
  return false;
}

/** 翻转一个可折叠块的折叠态（消息翻思考，工具翻参数与输出，子 agent 翻结论/合并） */
function flipFold(block: BlockView): BlockView {
  if (block.kind === "message") return { ...block, thinkingCollapsed: !block.thinkingCollapsed };
  if (block.kind === "tool") return { ...block, collapsedArgs: !block.collapsedArgs, collapsedOutput: !block.collapsedOutput };
  if (block.kind === "agent") return { ...block, collapsed: !block.collapsed };
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
            // 署名跟随本轮实际产出模型（E18：路由切到备选后归属正确），并清除本轮暂存
            model: state.activeModel,
            text: state.streaming.text,
            thinking: state.streaming.thinking || undefined,
            isError: state.streaming.isError,
            time: formatTime(),
          })
        : state;
      const status: "idle" | "running" =
      event.stopReason === "tool_use" || event.stopReason === "tool_calls" ? "running" : "idle";
      return { ...merged, activeModel: undefined, streaming: undefined, status, scrollOffset: 0, turnIndex: state.turnIndex + 1 };
    }
    case "error": {
      if (!state.streaming || (!state.streaming.text && !state.streaming.thinking)) {
        // 无前缀内容的独立错误：展示错误消息块并回到空闲（error 即轮边界）；
        // 与 interact catch 同一套 modelErrorText，模型类错误带换模型/配 key 引导
        return {
          ...state,
          activeModel: undefined,
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
      // 模型路由切换观察事件：追加常驻通知行（主模型不可用自动切备选），消息列表展示而非一闪而过；
      // 并暂存备选为本轮产出模型（E18），done 落消息块时作署名
      return {
        ...state,
        activeModel: event.to,
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

/** 是否有运行中的子 agent（P8）：主 agent 等子 agent 结论时主状态非 running，
 *  Esc 判定据此仍走「打断」而非「双击退出」，子 agent 活跃时 Esc 一次即级联中断 */
export function hasRunningAgent(agents: AgentNode[]): boolean {
  return agents.some((a) => a.path !== "/root" && a.status === "running");
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

/** HookEvent → 状态（用户输入 / 工具生命周期 / 子 agent 活动 / 会话边界）。
 *  agent 生命周期事件可附带 spawnedAt/completedAt（loop 侧注入），state 本身保持纯函数 */
export function reduceHook(state: TuiState, event: AgentEventMeta): TuiState {
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
      // 已存在条目（followup 唤醒已完成/中断的 agent，P9）：重置为运行态、清完成时刻，
      // 树重新亮起（否则条目停在上一次终态、AgentStrip 10s 后过滤消失后不再出现）；
      // 不存在（初次派生）：追加新条目。两种都加一条 spawned 活动行。
      // spawnedAt：事件未携带时保留原值（loop 订阅侧恒注入当前时刻，此处兜底直调 reducer 的测试路径）
      return {
        ...state,
        agents: state.agents.some((a) => a.path === event.path)
          ? state.agents.map((a) =>
              a.path === event.path
                ? { path: a.path, status: "running" as const, spawnedAt: event.spawnedAt ?? a.spawnedAt, completedAt: null }
                : a,
            )
          : [...state.agents, { path: event.path, status: "running", spawnedAt: event.spawnedAt ?? null, completedAt: null }],
        blocks: [...state.blocks, { kind: "agent", event: "spawned", path: event.path, collapsed: true }],
      };
    case "AgentCompleted":
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.path === event.path ? { ...a, status: "completed", completedAt: event.completedAt ?? null } : a,
        ),
        blocks: [
          ...state.blocks,
          {
            kind: "agent",
            event: "completed",
            path: event.path,
            conclusion: event.conclusion,
            mergeResult: event.mergeResult,
            collapsed: true,
          },
        ],
      };
    case "AgentInterrupted":
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.path === event.path ? { ...a, status: "interrupted", completedAt: event.completedAt ?? null } : a,
        ),
        blocks: [...state.blocks, { kind: "agent", event: "interrupted", path: event.path, collapsed: true }],
      };
    case "Stop":
      // 只把主 agent（/root）的 Stop 视为回合空闲：子 agent 每轮结束也发 Stop，
      // 放行会把主界面误打成「空闲」（P8——Esc 判定依赖状态，见 hasRunningAgent）
      if (event.agentPath && event.agentPath !== "/root") return state;
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
    case "paste": {
      // 粘贴：bracketed paste 整段插入（多行拆行，超行数截断）；/connect key 输入态并入 key 缓冲
      //（G-7 粘贴含换行的 key 时清掉换行/空白——API key 无空白，误带换行会污染提交值）；
      // 其它弹窗（session/permission 等）打开时输入框不可见或不可编辑，粘贴忽略不误改状态
      if (state.modal?.kind === "connect-key") {
        return { ...state, modal: { ...state.modal, key: state.modal.key + action.text.replace(/\s+/g, "") } };
      }
      if (state.modal) return state;
      const prompt = pasteText(state.prompt, action.text);
      return { ...state, prompt, candidate: recomputeCandidate(prompt, state.candidate) };
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
    case "delete-line": {
      const prompt = deleteLine(state.prompt);
      return { ...state, prompt, candidate: recomputeCandidate(prompt, state.candidate) };
    }
    case "delete-to-end": {
      const prompt = deleteToEnd(state.prompt);
      return { ...state, prompt, candidate: recomputeCandidate(prompt, state.candidate) };
    }
    case "delete-word": {
      const prompt = deleteWord(state.prompt);
      return { ...state, prompt, candidate: recomputeCandidate(prompt, state.candidate) };
    }
    case "cursor": {
      // 普通移动光标：清除选区（选择是临时态，编辑/移动即取消）
      return { ...state, prompt: { ...moveCursor(state.prompt, action.dir), sel: null } };
    }
    case "select": {
      // Shift+方向键扩展选区（B-2）：锚点首按固定在当前位，光标（焦点端）移动扩展/收缩
      const p = state.prompt;
      const anchor = p.sel ?? { line: p.curLine, col: p.curCol };
      const moved = moveCursor(p, action.dir);
      // 不重算 slash 候选（文本未变，与 cursor 分支一致）：/ 开头时候选已收起不会被 Shift+方向键重新弹起（审查 L-1）
      return { ...state, prompt: { ...moved, sel: anchor } };
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
          ? { ...state.prompt, historyIndex: -1, sel: null }
          : (() => {
              const lines = history[nextIndex]!.split("\n");
              const last = lines.at(-1) ?? "";
              return {
                lines,
                curLine: lines.length - 1,
                curCol: Array.from(last).length,
                history,
                historyIndex: nextIndex,
                sel: null,
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
        sel: null,
      };
      return { ...state, prompt, candidate: recomputeCandidate(prompt, state.candidate) };
    }
    case "modal-nav": {
      if (!state.candidate)
        return { ...state, prompt: { ...moveCursor(state.prompt, action.dir === -1 ? "up" : "down"), sel: null } };
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
    case "session-action-toggle":
    case "extensions-toggle":
    case "copy":
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
  return { ...prompt, lines, curCol: prompt.curCol + Array.from(text).length, sel: null };
}

/** 粘贴整段文本：光标处插入，\r\n/\n 拆多行（bracketed paste 整段插入），总行数超上限截断。
 *  D-6=45 截断策略：优先保光标前/后的内容（head 接光标前、tail 接光标后），超限截中间粘贴段，
 *  不再从头 slice 丢光标后已有文本；原行已满时退化为单行贴入光标处。 */
function pasteText(prompt: PromptState, text: string): PromptState {
  const line = prompt.lines[prompt.curLine] ?? "";
  const before = Array.from(line).slice(0, prompt.curCol).join("");
  const after = Array.from(line).slice(prompt.curCol).join("");
  const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (parts.length === 1) {
    const lines = [...prompt.lines];
    lines[prompt.curLine] = before + parts[0]! + after;
    return { ...prompt, lines, curCol: prompt.curCol + Array.from(parts[0]!).length, sel: null };
  }
  const head = before + parts[0]!;
  const tail = parts.at(-1)! + after;
  // 可用中间行数 = 上限 - 光标行外原有行 - head/tail 两行；不足则截中间段（保头尾）
  const otherRows = prompt.lines.length - 1;
  const availMids = MAX_PROMPT_LINES - otherRows - 2;
  if (availMids < 0) {
    // 原行已满（otherRows ≥ MAX-1）：粘贴退化为贴入光标处单行，保光标前后文本
    const joined = parts.join("");
    const lines = [...prompt.lines];
    lines[prompt.curLine] = before + joined + after;
    return { ...prompt, lines, curCol: prompt.curCol + Array.from(joined).length, sel: null };
  }
  const mids = parts.length - 2 <= availMids ? parts.slice(1, -1) : parts.slice(1, 1 + Math.max(0, availMids));
  const lines = [
    ...prompt.lines.slice(0, prompt.curLine),
    head,
    ...mids,
    tail,
    ...prompt.lines.slice(prompt.curLine + 1),
  ];
  const curLine = prompt.curLine + mids.length + 1;
  const curCol = Array.from(tail).length - Array.from(after).length;
  return { ...prompt, lines, curLine, curCol, sel: null };
}

/** 光标处换行（超 20 行忽略） */
function splitLine(prompt: PromptState): PromptState {
  const line = prompt.lines[prompt.curLine] ?? "";
  const before = Array.from(line).slice(0, prompt.curCol).join("");
  const after = Array.from(line).slice(prompt.curCol).join("");
  const lines = [...prompt.lines.slice(0, prompt.curLine), before, after, ...prompt.lines.slice(prompt.curLine + 1)];
  return { ...prompt, lines, curLine: prompt.curLine + 1, curCol: 0, sel: null };
}

/** 退格：删光标前字符；行首时与上一行合并（编辑一律清选区） */
function deleteBackward(prompt: PromptState): PromptState {
  const line = prompt.lines[prompt.curLine] ?? "";
  if (prompt.curCol > 0) {
    const chars = Array.from(line);
    const before = chars.slice(0, prompt.curCol - 1).join("");
    const after = chars.slice(prompt.curCol).join("");
    const lines = [...prompt.lines];
    lines[prompt.curLine] = before + after;
    return { ...prompt, lines, curCol: prompt.curCol - 1, sel: null };
  }
  if (prompt.curLine === 0) return { ...prompt, sel: null };
  const prev = prompt.lines[prompt.curLine - 1] ?? "";
  const lines = [...prompt.lines.slice(0, prompt.curLine - 1), prev + line, ...prompt.lines.slice(prompt.curLine + 1)];
  return { ...prompt, lines, curLine: prompt.curLine - 1, curCol: Array.from(prev).length, sel: null };
}

/** 删除：删光标处字符；行尾时与下一行合并（编辑一律清选区） */
function deleteForward(prompt: PromptState): PromptState {
  const line = prompt.lines[prompt.curLine] ?? "";
  const chars = Array.from(line);
  if (prompt.curCol < chars.length) {
    const before = chars.slice(0, prompt.curCol).join("");
    const after = chars.slice(prompt.curCol + 1).join("");
    const lines = [...prompt.lines];
    lines[prompt.curLine] = before + after;
    return { ...prompt, lines, sel: null };
  }
  if (prompt.curLine >= prompt.lines.length - 1) return { ...prompt, sel: null };
  const next = prompt.lines[prompt.curLine + 1] ?? "";
  const lines = [...prompt.lines.slice(0, prompt.curLine), line + next, ...prompt.lines.slice(prompt.curLine + 2)];
  return { ...prompt, lines, sel: null };
}

/** 光标移动（跨行时保持目标列到行末截断）；start/end = 行首/行尾（Ctrl+A/E） */
function moveCursor(prompt: PromptState, dir: "left" | "right" | "up" | "down" | "start" | "end"): PromptState {
  const line = prompt.lines[prompt.curLine] ?? "";
  const colCount = Array.from(line).length;
  switch (dir) {
    case "start":
      return { ...prompt, curCol: 0 };
    case "end":
      return { ...prompt, curCol: colCount };
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

/** 删到行尾：光标后整段清除（Ctrl+K，光标不动） */
function deleteToEnd(prompt: PromptState): PromptState {
  const line = prompt.lines[prompt.curLine] ?? "";
  const chars = Array.from(line);
  const before = chars.slice(0, prompt.curCol).join("");
  const lines = [...prompt.lines];
  lines[prompt.curLine] = before;
  return { ...prompt, lines, sel: null };
}

/** 删整行（Ctrl+U）：清空当前行、光标回行首；当前行已空且上方有行时删掉该行、光标到上一行尾——
 *  连续按 Ctrl+U 一行行往上清（D-2=48，不再停在行首不动） */
function deleteLine(prompt: PromptState): PromptState {
  const lines = [...prompt.lines];
  if ((prompt.lines[prompt.curLine] ?? "") === "" && prompt.curLine > 0) {
    // 行已空：移除整行，光标到上一行末尾（下一次 Ctrl+U 继续清上一行）
    lines.splice(prompt.curLine, 1);
    const prev = lines[prompt.curLine - 1] ?? "";
    return { ...prompt, lines, curLine: prompt.curLine - 1, curCol: Array.from(prev).length, sel: null };
  }
  lines[prompt.curLine] = "";
  return { ...prompt, lines, curCol: 0, sel: null };
}

/** 删前词：先退过连续空格，再退过连续非空格（Ctrl+W；行首无词则不动） */
function deleteWord(prompt: PromptState): PromptState {
  const line = prompt.lines[prompt.curLine] ?? "";
  const chars = Array.from(line);
  let col = prompt.curCol;
  while (col > 0 && chars[col - 1] === " ") col--;
  while (col > 0 && chars[col - 1] !== " ") col--;
  const before = chars.slice(0, col).join("");
  const after = chars.slice(prompt.curCol).join("");
  const lines = [...prompt.lines];
  lines[prompt.curLine] = before + after;
  return { ...prompt, lines, curCol: col, sel: null };
}