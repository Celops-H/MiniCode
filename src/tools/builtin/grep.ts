import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { validateInput } from "../base.js";
import type { Tool } from "../base.js";

const schema = z.object({
  pattern: z.string(),
  /** 搜索起始目录，默认当前工作目录 */
  path: z.string().optional(),
  /** 文件名过滤，支持 * 通配符 */
  glob: z.string().optional(),
});

/** 按正则搜索文件内容，返回 文件:行号:内容 的匹配列表 */
export const grepTool: Tool = {
  name: "grep",
  description: "按正则搜索文件内容，返回 文件:行号:内容 的匹配列表",
  inputSchema: schema,
  isReadOnly: true,
  requiresUserInteraction: false,
  maxResultSizeChars: 30000,
  async execute(input) {
    const { pattern, path: dir, glob: fileGlob } = validateInput<{
      pattern: string;
      path?: string;
      glob?: string;
    }>(grepTool, input);
    const regex = new RegExp(pattern);
    const cwd = dir ?? process.cwd();
    const results: string[] = [];
    for (const file of await listTextFiles(cwd)) {
      if (fileGlob && !matchesGlob(path.basename(file), fileGlob)) continue;
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue; // 非文本文件跳过
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (regex.test(line)) {
          results.push(`${file}:${i + 1}:${line}`);
        }
      }
    }
    return results.length > 0 ? results.join("\n") : "未找到匹配内容";
  },
};

/** 递归收集文本文件，跳过 node_modules 与 .git，限制深度 */
async function listTextFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 12) return [];
  const result: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listTextFiles(full, depth + 1)));
    } else if (entry.isFile()) {
      result.push(full);
    }
  }
  return result;
}

/** 简单 glob 匹配：* 匹配任意片段 */
function matchesGlob(file: string, pattern: string): boolean {
  const regex = new RegExp("^" + pattern.split("*").map(escapeRegExp).join(".*") + "$");
  return regex.test(file);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
