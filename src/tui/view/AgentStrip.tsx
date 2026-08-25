/**
 * 底栏 agent 树（新任务 2）：main() 恒在首行，子 agent 各一行（路径末段 + ()）。
 * 只读展示当前会话已派生的 agent；选择/切换（↓ 键/鼠标悬停高亮）见 TASKS 待排期（任务量大，待商榷）。
 */
import { createMemo } from "solid-js";
import type { JSX } from "@opentui/solid";
import { theme } from "./theme.js";

/** agent 路径 → 展示名：/root → main()；/root/task_1 → task_1()（无语义名，用路径末段） */
function agentLabel(path: string): string {
  if (path === "/root") return "main()";
  const tail = path.split("/").filter(Boolean).at(-1) ?? path;
  return `${tail}()`;
}

/** 最多展示行数（再多折叠为 +N），防 agent 很多时吃掉整个屏幕 */
const MAX_ROWS = 5;

export function AgentStrip(props: { agents: string[] }): JSX.Element {
  // 用 createMemo 读 props.agents：组件体顶层常量只读一次，且 App 外层 length 布尔 memo 值相等
  // 门控短路（true→true 不重跑），live spawn 新 agent 后底栏不会刷新——必须进响应式上下文
  const shown = createMemo(() => props.agents.slice(0, MAX_ROWS));
  const overflow = createMemo(() => props.agents.length - shown().length);
  return (
    <box flexDirection="column" flexShrink={0} paddingX={1} paddingTop={1} backgroundColor={theme.backgroundPanel}>
      {shown().map((p) => (
        <text fg={p === "/root" ? theme.foregroundAccent : theme.textMuted}>{agentLabel(p)}</text>
      ))}
      {overflow() > 0 ? <text fg={theme.textMuted}>+{overflow()} 更多 agent…</text> : null}
    </box>
  );
}