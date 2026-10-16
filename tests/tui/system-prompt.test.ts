/**
 * 层 1：系统提示词约束——锁死「回复纯文本、不渲染 Markdown」这一产品约定，
 * 防止未来改文案时丢了这个关键条款（model 输出 **xxx** 乱码的根因）。
 */
import { it, expect } from "vitest";
import { SYSTEM_PROMPT } from "../../src/tui/index.js";

it("系统提示词明确禁止 Markdown 符号（终端纯文本）", () => {
  expect(SYSTEM_PROMPT).toContain("纯文本");
  expect(SYSTEM_PROMPT).toContain("不渲染 Markdown");
  expect(SYSTEM_PROMPT).toContain("不要凭记忆编造");
});

it("系统提示词要求汇报区分实测与推断", () => {
  expect(SYSTEM_PROMPT).toContain("实测与推断");
  expect(SYSTEM_PROMPT).toContain("未验证");
});

it("系统提示词要求先探目录规模，不递归进生成目录", () => {
  expect(SYSTEM_PROMPT).toContain("规模");
  expect(SYSTEM_PROMPT).toContain("node_modules");
  expect(SYSTEM_PROMPT).toContain("递归");
});

it("系统提示词要求搜文件用内置 grep、读文件用内置 read", () => {
  expect(SYSTEM_PROMPT).toContain("grep");
  expect(SYSTEM_PROMPT).toContain("read");
  expect(SYSTEM_PROMPT).toContain("内置");
});

it("系统提示词给出待办清单使用时机", () => {
  expect(SYSTEM_PROMPT).toContain("todo");
  expect(SYSTEM_PROMPT).toContain("待办清单");
});

it("系统提示词编号按分节各自从 1 起，不跨节连号", () => {
  // 分节标题已表达分组，编号跨节递增会让「第 N 条」与所在节脱节
  const sections = SYSTEM_PROMPT.split("\n【").slice(1);
  expect(sections.length).toBeGreaterThan(1);
  for (const section of sections) {
    expect(section.split("\n")[1], section.slice(0, 12)).toMatch(/^1\. /);
  }
  expect(SYSTEM_PROMPT).not.toMatch(/^\d{2,}\. /m);
});

it("多 Agent 协作口径：只留一句指路，派活细节归协作工具描述", () => {
  expect(SYSTEM_PROMPT).toContain("协作工具描述");
  // 派活后继续、自动唤醒、证据要求等细节只在工具描述里讲一次，提示词不重述
  expect(SYSTEM_PROMPT).not.toContain("自动唤醒你");
  expect(SYSTEM_PROMPT).not.toContain("已派发");
  expect(SYSTEM_PROMPT).not.toContain("证据要求");
  // 提示词随会话无条件下发，单 agent 会话没有 spawn_agent，故不点名任何协作工具
  expect(SYSTEM_PROMPT).not.toContain("spawn_agent");
  // 已无等待工具：不写「等结论齐全」这类挂起等待口径
  expect(SYSTEM_PROMPT).not.toContain("等结论齐全");
});

it("系统提示词自身不带 markdown 符号（不给模型示范要禁止的格式）", () => {
  expect(SYSTEM_PROMPT).not.toContain("**");
  expect(SYSTEM_PROMPT).not.toContain("```");
  expect(SYSTEM_PROMPT).not.toMatch(/(?<!\S)#[^#\n]/);
});