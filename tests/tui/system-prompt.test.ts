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

it("多 Agent 协作口径：派活后结束本轮，等子 agent 完成唤醒再汇总（无挂起等待）", () => {
  expect(SYSTEM_PROMPT).toContain("自动唤醒你");
  // 已无等待工具：不写「等结论齐全」这类挂起等待口径
  expect(SYSTEM_PROMPT).not.toContain("等结论齐全");
});

it("系统提示词自身不带 markdown 符号（不给模型示范要禁止的格式）", () => {
  expect(SYSTEM_PROMPT).not.toContain("**");
  expect(SYSTEM_PROMPT).not.toContain("```");
  expect(SYSTEM_PROMPT).not.toMatch(/(?<!\S)#[^#\n]/);
});