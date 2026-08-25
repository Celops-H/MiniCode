import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { validateInput } from "../base.js";
import type { Tool } from "../base.js";
import { currentCwd, resolvePath } from "../file-state.js";

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
  isConcurrencySafe: () => true,
  requiresUserInteraction: false,
  maxResultSizeChars: 30000,
  async execute(input) {
    const { pattern, path: dir, glob: fileGlob } = validateInput<{
      pattern: string;
      path?: string;
      glob?: string;
    }>(grepTool, input);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      // 模型常给内联大小写标志（(?i)）等 JS 不认的写法，返回可读原因让模型改词重试
      return `grep 正则无效：${(err as Error).message}`;
    }
    const cwd = dir ? resolvePath(dir) : currentCwd();
    const results: string[] = [];
    const { files, truncated } = await listTextFiles(cwd);
    for (const file of files) {
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
        regex.lastIndex = 0; // 防带 g/y 标志的正则跨行推进 lastIndex 漏匹配
        if (regex.test(line)) {
          results.push(`${file}:${i + 1}:${line}`);
        }
      }
    }
    // 深度超限时明确标记结果不完整，避免模型误判「搜索完整、无匹配」
    const suffix = truncated ? "\n[深度超限，结果不完整]" : "";
    return results.length > 0
      ? results.join("\n") + suffix
      : truncated
        ? "未找到匹配内容（深度超限，结果不完整）"
        : "未找到匹配内容";
  },
};

/** 递归收集文本文件，跳过 node_modules 与 .git，限制深度；深度超限时 truncated 置位 */
async function listTextFiles(
  dir: string,
  depth = 0,
): Promise<{ files: string[]; truncated: boolean }> {
  if (depth > 12) return { files: [], truncated: true };
  const result: { files: string[]; truncated: boolean } = { files: [], truncated: false };
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await listTextFiles(full, depth + 1);
      result.files.push(...sub.files);
      result.truncated = result.truncated || sub.truncated;
    } else if (entry.isFile()) {
      result.files.push(full);
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
