import { open, readdir, readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { validateInput, outputLimitNote } from "../base.js";
import type { Tool } from "../base.js";
import { currentCwd, resolvePath } from "../file-state.js";

/** 二进制嗅探读取的字节数（git 同款 8000）：前段出现 NUL 字节即判定二进制 */
const BINARY_SNIFF_BYTES = 8000;

const MAX_RESULT_CHARS = 30000;

const schema = z.object({
  pattern: z.string().describe("JavaScript 正则（不支持 (?i) 等内联标志）"),
  path: z.string().optional().describe("搜索起始目录或单个文件，缺省当前工作目录"),
  include: z
    .string()
    .optional()
    .describe('只搜文件名匹配的文件，如 "*.{ts,tsx}"；含 / 时按相对搜索根的路径匹配'),
  limit: z.number().int().positive().optional().describe("最多返回的匹配行数，缺省不限制"),
});

/** 按正则搜索文件内容，返回 文件:行号:内容 的匹配列表 */
export const grepTool: Tool = {
  name: "grep",
  description:
    "按正则搜索文件内容，返回 文件:行号:内容 的匹配列表。" +
    "include 过滤文件名，如 *.{ts,tsx}，含 / 时按路径匹配；" +
    "limit 限制返回的匹配行数；" +
    "path 可传目录或单个文件。" +
    outputLimitNote(MAX_RESULT_CHARS),
  inputSchema: schema,
  isReadOnly: true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: MAX_RESULT_CHARS,
  async execute(input) {
    const { pattern, path: dir, include, limit } = validateInput<{
      pattern: string;
      path?: string;
      include?: string;
      limit?: number;
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
    // path 指向文件时直接搜该文件（rg 同款语义）；不存在与无法访问分开提示
    // （原实现把文件当目录 readdir，抛 ENOTDIR 原始错误）
    let statResult: Stats | undefined;
    let statError: NodeJS.ErrnoException | undefined;
    try {
      statResult = await stat(cwd);
    } catch (err) {
      statError = err as NodeJS.ErrnoException;
    }
    if (!statResult) {
      if (statError?.code === "ENOENT") return `搜索路径不存在：${dir ?? cwd}`;
      return `搜索路径无法访问：${dir ?? cwd}（${statError?.message ?? "未知错误"}）`;
    }
    let files: string[];
    let truncated = false;
    if (statResult.isFile()) {
      files = [cwd];
    } else {
      ({ files, truncated } = await listTextFiles(cwd));
    }
    // include 按搜索根下的相对路径匹配：不含 / 的模式按文件名匹配任意层级，
    // 含 / 的按相对路径匹配，目录段不再被静默忽略
    const root = statResult.isFile() ? path.dirname(cwd) : cwd;
    let limitReached = false;
    for (const file of files) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (include && !matchesInclude(rel, include)) continue;
      let content: string;
      try {
        // 二进制文件嗅探跳过：readFile("utf8") 对二进制不抛错，整读大体积二进制
        // 进内存且乱码行会命中正则给模型喂假匹配——前段含 NUL 即视为二进制（git 同款做法）
        if (await isBinaryFile(file)) continue;
        content = await readFile(file, "utf8");
      } catch {
        continue; // 读取失败跳过
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        regex.lastIndex = 0; // 防带 g/y 标志的正则跨行推进 lastIndex 漏匹配
        if (!regex.test(line)) continue;
        if (limit !== undefined && results.length >= limit) {
          limitReached = true;
          break;
        }
        results.push(`${file}:${i + 1}:${line}`);
      }
      if (limitReached) break;
    }
    // 深度超限或达 limit 时明确标记结果不完整，避免模型误判「搜索完整、无匹配」
    const notes: string[] = [];
    if (truncated) notes.push("深度超限，结果不完整");
    if (limitReached) notes.push(`已达 limit ${limit}，结果被截断`);
    const note = notes.join("；");
    return results.length > 0
      ? results.join("\n") + (note ? `\n[${note}]` : "")
      : `未找到匹配内容${note ? `（${note}）` : ""}`;
  },
};

/**
 * NUL 字节二进制嗅探：只读文件前段（BINARY_SNIFF_BYTES）判 NUL，不整读大文件。
 * @param file 文件路径
 * @returns 是否判定为二进制
 */
async function isBinaryFile(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

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

/**
 * include 模式匹配：模式不含 / 时按文件名匹配任意层级，含 / 时按相对搜索根的路径匹配。
 * @param rel 文件相对搜索根的路径，以 / 分隔
 * @param pattern include 模式
 * @returns 是否匹配
 */
function matchesInclude(rel: string, rawPattern: string): boolean {
  // 反斜杠按路径分隔符处理，避免 Windows 风格的 src\*.ts 静默不匹配
  const pattern = rawPattern.replace(/\\/g, "/");
  const target = pattern.includes("/") ? rel : rel.slice(rel.lastIndexOf("/") + 1);
  return new RegExp(`^${globToRegExp(pattern)}$`).test(target);
}

/** include 模式转正则片段：* 不跨层级，** 跨层级，{a,b} 任选其一 */
function globToRegExp(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:[^/]*/)*"; // **/ 匹配零或多级目录
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i + 1);
      if (close === -1) {
        out += "\\{";
        continue;
      }
      out += `(?:${pattern.slice(i + 1, close).split(",").map(globToRegExp).join("|")})`;
      i = close;
    } else {
      out += escapeRegExp(ch);
    }
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
