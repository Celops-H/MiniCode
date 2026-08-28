import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../tools/index.js";

/** 单个技能条目（BACKEND §20） */
export interface SkillInfo {
  name: string;
  description: string;
  /** 来源层：项目技能与用户技能同名时项目覆盖用户（回写名单按来源落层） */
  source: "project" | "user";
  /** SKILL.md 绝对路径 */
  filePath: string;
}

export interface ScanSkillsOptions {
  /** 项目技能目录（缺省 <cwd>/.minicode/skills） */
  projectDir?: string;
  /** 用户技能目录（缺省 ~/.minicode/skills） */
  userDir?: string;
  /** 关闭名单（config.skills.disabled 全局/项目并集）：命中技能名的技能不出现 */
  disabled?: string[];
}

/**
 * 扫描技能目录（BACKEND §20）：项目 `.minicode/skills/` 与用户 `~/.minicode/skills/` 下
 * 每个子目录一个技能（含 SKILL.md），同名项目覆盖用户，再按 disabled 名单过滤。
 * 目录不存在属正常缺省（返回空）；单个技能读取失败跳过，不阻断其余技能。
 */
export async function scanSkills(options: ScanSkillsOptions = {}): Promise<SkillInfo[]> {
  const projectDir = options.projectDir ?? path.join(process.cwd(), ".minicode", "skills");
  const userDir = options.userDir ?? path.join(os.homedir(), ".minicode", "skills");
  const disabled = new Set(options.disabled ?? []);
  const [project, user] = await Promise.all([
    scanOneDir("project", projectDir),
    scanOneDir("user", userDir),
  ]);
  // 同名覆盖：项目条目顶掉用户条目
  const byName = new Map(user.map((s) => [s.name, s]));
  for (const skill of project) byName.set(skill.name, skill);
  return [...byName.values()].filter((s) => !disabled.has(s.name));
}

/** 扫描单个技能目录：读每个子目录的 SKILL.md 并解析 frontmatter */
async function scanOneDir(source: SkillInfo["source"], dir: string): Promise<SkillInfo[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // 目录不存在或不可读：视为无技能
  }
  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(dir, entry.name, "SKILL.md");
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      continue; // 无 SKILL.md 或读不了：跳过该子目录
    }
    const { attrs, body } = parseFrontmatter(text);
    skills.push({
      name: attrs.name || entry.name,
      description: attrs.description || firstLine(body),
      source,
      filePath,
    });
  }
  return skills;
}

/**
 * 解析 SKILL.md 的 YAML frontmatter：自实现 `key: value` 两行子集
 * （无嵌套/无列表，够用即可，BACKEND §20）；未知键忽略。
 * @param text SKILL.md 原文
 * @returns 属性表（CRLF 归一后解析）与正文（frontmatter 之后的全部内容）
 */
export function parseFrontmatter(text: string): { attrs: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { attrs: {}, body: normalized };
  // 从 3 起搜收尾分隔线：兼容空 frontmatter（---\n---）——开头的 \n 即收尾行所在
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) return { attrs: {}, body: normalized };
  const attrs: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) attrs[key] = value;
  }
  // 收尾 --- 行之后是正文；收尾行是文件最后一行（无换行）时正文为空
  const bodyStart = normalized.indexOf("\n", end + 1);
  const body = bodyStart >= 0 ? normalized.slice(bodyStart + 1) : "";
  return { attrs, body };
}

/** 正文首个非空行（description 缺省回退） */
function firstLine(body: string): string {
  const line = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? "";
}

/**
 * 「可用技能」系统提示词段（BACKEND §20）：逐条 name — description + 取用方式一句话。
 * 与主系统提示词同风格（纯文本、【】分节）。
 */
export function buildSkillsPromptSection(skills: SkillInfo[]): string {
  return [
    "【可用技能】",
    "需要某个技能的完整指令时，用 skill 工具传入技能名取回全文并照做：",
    ...skills.map((s) => `- ${s.name} — ${s.description}`),
  ].join("\n");
}

/**
 * 内置 skill 工具（BACKEND §20）：入参 { name }，执行返回该技能 SKILL.md 正文（模型照做）。
 * 只读纯读文件，权限快速放行；正文超限由执行层按 maxResultSizeChars 统一截断。
 */
export function createSkillTool(skills: SkillInfo[]): Tool {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const nameSchema = z.object({ name: z.string().min(1) });
  return {
    name: "skill",
    description:
      "获取技能的完整指令正文。入参 { name }，name 必须是系统提示词【可用技能】清单中列出的技能名；" +
      "取回后按正文内容执行该技能。",
    inputSchema: nameSchema,
    isReadOnly: true,
    requiresUserInteraction: false,
    maxResultSizeChars: 20_000,
    async execute(input) {
      const { name } = nameSchema.parse(input);
      const skill = byName.get(name);
      if (!skill) {
        return {
          output: `未知技能：${name}。可用技能：${[...byName.keys()].join("、") || "（无）"}`,
          isError: true,
        };
      }
      try {
        const text = await readFile(skill.filePath, "utf8");
        // 只回正文：frontmatter 是元数据，模型照做的是正文（BACKEND §20）
        const { body } = parseFrontmatter(text);
        return body.trim() ? body : "（技能正文为空）";
      } catch (err) {
        return {
          output: `读取技能失败：${skill.name}（${(err as NodeJS.ErrnoException).message}）`,
          isError: true,
        };
      }
    },
  };
}
