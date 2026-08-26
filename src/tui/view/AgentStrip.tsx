/**
 * 底栏 agent 树（P1-5 定稿 + 用户复核）：`● main` 仅多 agent 启用（存在子 agent）时显示；
 * 子 agent 运行中 `( ) 名称`、完成 `(√) 名称 耗时`（中断 `(×)`），完成/中断 10s 后从树消失；
 * 层级树线 `├─`/`└─`/`│`：main 子层对齐 main 前圆点列，更下层对齐父 `( )`/`(√)` 括号中心列；
 * main 首行、子 agent 次行紧凑。
 * 纯展示不切换：选择/悬停高亮见 TASKS 待排期。完成条目消失由本组件定时器过滤（state 保留，
 * 长会话内存由 blocks 消息承担，树只读当前活动子集）。
 */
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { AgentNode } from "../state.js";
import { theme } from "./theme.js";

/** 完成条目展示时长（ms），超时从树消失 */
const DONE_VISIBLE_MS = 10_000;

/** 路径 → 父路径（/root 的子 agent → /root；深层 → 上一段） */
function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/root" : path.slice(0, i);
}

/** 路径末段（展示名，不带括号）：/root → main；/root/task_1 → task_1 */
function agentName(path: string): string {
  if (path === "/root") return "main";
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** 完成耗时展示：1s 内显示 <1s，否则整秒 */
function durText(ms: number | null): string {
  if (ms == null) return "";
  const sec = ms / 1000;
  return sec < 1 ? "<1s" : `${Math.round(sec)}s`;
}

/** 单条内容：main=`● main`（无状态括号——括号是子 agent 状态占位，main 恒运行）；
 *  子 agent=`( ) 名` / `(√) 名 耗时` / `(×) 名` */
function agentContent(a: AgentNode): string {
  if (a.path === "/root") return "● main";
  const name = agentName(a.path);
  if (a.status === "completed") {
    // 派生时刻缺失（测试/直调 reducer）时只显名称不带耗时，避免尾随空格
    const dur = durText(a.completedAt != null && a.spawnedAt != null ? a.completedAt - a.spawnedAt : null);
    return `(√) ${name}${dur ? ` ${dur}` : ""}`;
  }
  if (a.status === "interrupted") return `(×) ${name}`;
  return `( ) ${name}`;
}

/** 内容里括号中心列偏移：`( ) 名`/`(√) 名` → 括号中间空格列（起点+1）；`● main` 无括号 → 圆点列（0） */
function parenCenterOffset(content: string): number {
  const open = content.indexOf("(");
  return open >= 0 && content[open + 1] === ")" ? open : open + 1;
}

/**
 * 树渲染：DFS 从 /root 起，子 agent 连接线放父「中心列」——main（`● main` 无括号）为中心 0 即圆点列，
 * 子 agent 放各自括号中心列；祖先层的竖线（│/空格）放各自中心列——层级竖线对齐父圆点/括号中心。
 * 返回逐行字符串（行内左侧用空格补齐，保证竖线列对齐）。
 */
function renderTree(nodes: AgentNode[]): string[] {
  const present = new Set(nodes.map((n) => n.path));
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  // 子表：父 → 子路径；父被剪枝（完成条目消失）时子重挂到最近存活祖先，运行中子 agent 不失联
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.path === "/root") continue; // 树根无父，跳过（避免挂为自身子节点）
    let p = parentPath(n.path);
    while (p !== n.path && !present.has(p)) p = parentPath(p);
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(n.path);
  }
  for (const list of childrenOf.values()) list.sort();

  const rows: string[] = [];
  const render = (path: string, ancCols: number[], ancMore: boolean[], isLast: boolean): void => {
    const node = byPath.get(path);
    if (!node) return; // /root 缺失等防御（生产恒有）
    const content = agentContent(node);
    // ancCols 由调用方逐层推入、无空洞，索引必存在
    const connectorCol = ancCols.length > 0 ? ancCols[ancCols.length - 1]! : -1;
    const startCol = connectorCol >= 0 ? connectorCol + 3 : 0;
    const row: string[] = new Array(startCol + content.length).fill(" ");
    // 祖先层竖线：放各自括号中心列（该祖先还有后续兄弟则 │，否则空）
    for (let i = 0; i < ancCols.length - 1; i++) row[ancCols[i]!] = ancMore[i] ? "│" : " ";
    // 直接父连接线：├─ / └─ 放父括号中心列
    if (connectorCol >= 0) {
      row[connectorCol] = isLast ? "└" : "├";
      row[connectorCol + 1] = "─";
    }
    for (let i = 0; i < content.length; i++) row[startCol + i] = content[i]!;
    rows.push(row.join(""));
    const myCenter = startCol + parenCenterOffset(content);
    const kids = childrenOf.get(path) ?? [];
    for (let i = 0; i < kids.length; i++) {
      render(kids[i]!, [...ancCols, myCenter], [...ancMore, i < kids.length - 1], i === kids.length - 1);
    }
  };
  render("/root", [], [], true);
  return rows;
}

export function AgentStrip(props: { agents: AgentNode[] }): JSX.Element {
  // 10s 消失：每秒刷新一次 now，过滤完成/中断已超时的条目（运行中恒显示）
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });
  const visible = createMemo(() =>
    props.agents.filter(
      (a) => a.status === "running" || (a.completedAt != null && now() - a.completedAt < DONE_VISIBLE_MS),
    ),
  );
  // 仅多 agent 启用（存在子 agent）时显示整棵树；只有 main 时底栏不占行（Show 响应式门控，
  // 不能组件体 if return null——store 更新后组件体不重跑，树在子 agent 派生时才出现会不显示）
  const rows = createMemo(() => {
    if (!visible().some((a) => a.path !== "/root")) return [];
    return renderTree(visible());
  });
  return (
    <Show when={rows().length > 0}>
      <box flexDirection="column" flexShrink={0} paddingX={1} paddingTop={1} backgroundColor={theme.backgroundPanel}>
        {rows().map((r) => (
          <text fg={theme.textMuted}>{r}</text>
        ))}
      </box>
    </Show>
  );
}
