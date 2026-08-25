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

it("系统提示词自身不带 markdown 符号（不给模型示范要禁止的格式）", () => {
  expect(SYSTEM_PROMPT).not.toContain("**");
  expect(SYSTEM_PROMPT).not.toContain("```");
  expect(SYSTEM_PROMPT).not.toMatch(/(?<!\S)#[^#\n]/);
});