import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 单个指令文件：来源路径 + 正文（BACKEND §21） */
export interface InstructionFile {
  path: string;
  content: string;
}

export interface LoadInstructionsOptions {
  homedir?: string;
  cwd?: string;
}

/** 项目级候选文件名：每级目录 AGENTS.md 优先、没有才读 CLAUDE.md 兜底（同级不重复注入，避免镜像内容重复占上下文） */
const PROJECT_INSTRUCTION_FILENAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * 读文件正文；文件不存在返回 null，其余读盘错误原样上抛（不静默吞权限/损坏问题）。
 * @param file 文件路径
 * @returns 正文或 null
 */
export async function readInstructionFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * 加载指令文件（BACKEND §21）：用户级 ~/.minicode/AGENTS.md 一份 + 项目级最近的一个
 * ——当前目录有指令文件（AGENTS.md 优先、CLAUDE.md 兜底）就用它，没有才逐级向上找，
 * 找到即停（E37）。不再收集到文件系统根的全部层级：越界加载项目外祖先目录的指令文件
 * 会把无关约定拼进提示词（cc 实际行为是收集根→cwd 全部层级，本项按 request.md 预定
 * 规则对齐为最近命中即停，差异已记录）。无文件返回空数组，静默无此段。
 * @param opts 路径选项（homedir / cwd 可注入，测试用）
 * @returns 指令文件列表（用户级在最前，项目级随后）
 */
export async function loadInstructionFiles(opts: LoadInstructionsOptions = {}): Promise<InstructionFile[]> {
  const home = opts.homedir ?? os.homedir();
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const files: InstructionFile[] = [];

  const userFile = path.join(home, ".minicode", "AGENTS.md");
  const userContent = await readInstructionFile(userFile);
  if (userContent !== null) files.push({ path: userFile, content: userContent });

  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const hit = await findInstructionFileInDir(dir);
    if (hit) {
      files.push(hit);
      break;
    }
    if (dir === path.parse(dir).root) break;
  }
  return files;
}

/** 单个目录内取指令文件：AGENTS.md 优先、没有才读 CLAUDE.md 兜底（同级不重复注入） */
async function findInstructionFileInDir(dir: string): Promise<InstructionFile | null> {
  for (const name of PROJECT_INSTRUCTION_FILENAMES) {
    const file = path.join(dir, name);
    const content = await readInstructionFile(file);
    if (content !== null) return { path: file, content };
  }
  return null;
}

/**
 * 把指令文件拼接为系统提示词段落（直接拼系统提示词，不用首条 user 消息方案）。
 * @param files loadInstructionFiles 的产出
 * @returns 指令段；空数组返回空串（无文件则静默无此段）
 */
export function buildInstructionsPrompt(files: InstructionFile[]): string {
  if (files.length === 0) return "";
  return [
    "【项目指令】（来自 AGENTS.md / CLAUDE.md 指令文件，是用户与项目侧的约定，优先遵守）",
    ...files.map((f) => f.content.trim()),
  ].join("\n\n");
}

/**
 * /init 提示词（BACKEND §21）：让模型分析代码库生成/改进项目根 AGENTS.md。
 * 要求先实际查证再动笔（不编造）、聚焦常用命令与架构与约定；已存在时不覆盖，
 * 在其基础上提出并落实改进建议。
 * @param existing 已存在的 AGENTS.md 正文；null 表示尚无此文件
 * @returns 发给模型的 init 提示词
 */
export function buildInitPrompt(existing: string | null): string {
  const head = existing
    ? "请分析当前代码库并改进本项目的 AGENTS.md（项目级指令文件，供 AI 编程助手感知项目约定）。已存在的文件内容附在末尾——不覆盖既有约定，读取后在回复里先给出改进建议，再用 write 工具落实改进。"
    : "请分析当前代码库，为本项目编写 AGENTS.md（项目级指令文件，供 AI 编程助手感知项目约定），用 write 工具写到项目根 AGENTS.md。";
  return `${head}
要求：
1. 先实际查证：读 README、package.json/构建脚本、目录结构、既有规则文件（AGENTS.md/CLAUDE.md/.cursor 等），不要凭记忆编造文件内容、目录结构或命令。
2. 产出聚焦：常用命令（构建/测试/检查）、架构概览、代码风格与约定、重要注意事项；吸收 README 与 .cursor 规则等重要内容。
3. 平实业务语言，简洁，不堆概念。
${existing ? `\n已存在的 AGENTS.md 内容：\n${existing}` : ""}`;
}
