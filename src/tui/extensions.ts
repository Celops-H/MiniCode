/**
 * /mcp 与 /skill 扩展面板的数据构造与配置回写（BACKEND §19/§20 回写规则）。
 * 回写规则「写回定义层」：配置有两层（全局 ~/.minicode/config.json 与项目 .minicode.json），
 * MCP server 定义在哪层就把 enabled 写回哪层；技能本体来自目录扫描，关闭名单按技能来源落层
 * （项目技能写项目配置、用户技能写全局配置）。失败不抛进程：返回/抛出错误由 loop 展示 toast。
 * 写盘风格与 connect.ts 一致：改原始 JSON → strict schema 校验 → mkdir + 缩进 2 写回。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { configSchema, type McpServerConfig } from "../config/index.js";
import { resolveConfigPaths } from "../config/paths.js";
import type { McpServerStatus } from "../mcp/index.js";
import type { SkillInfo } from "../skills/index.js";

/** 扩展面板行（state.ts 的 McpModalState/SkillModalState.rows 用） */
export interface ExtensionRow {
  /** mcp=服务名 / skill=技能名（回写定位键） */
  id: string;
  label: string;
  /** 副列：mcp=连接状态，skill=描述 */
  detail: string;
  enabled: boolean;
  /** skill 行来源层（回写落层用）；mcp 行的回写层由配置文件定位，不带 */
  source?: "project" | "user";
}

/** /mcp 面板行：配置 enabled 与 manager 装配状态合并（状态列：已连接/未启动/进程已退出/启动失败原因） */
export function buildMcpRows(servers: Record<string, McpServerConfig>, statuses: McpServerStatus[]): ExtensionRow[] {
  return Object.entries(servers).map(([name, cfg]) => {
    const enabled = cfg.enabled !== false;
    const status = statuses.find((s) => s.name === name);
    let detail: string;
    if (!enabled) detail = "未启动";
    else if (status?.started) detail = `已连接 · ${status.toolCount} 个工具`;
    else if (status?.exited) detail = "进程已退出（重开会话重拉）";
    else if (status?.error) detail = `启动失败：${truncate(status.error, 60)}`;
    else detail = "未启动";
    return { id: name, label: name, detail, enabled };
  });
}

/** /skill 面板行：扫描结果 + 关闭名单（启用 = 不在名单）；描述超长截断 */
export function buildSkillRows(skills: SkillInfo[], disabled: string[]): ExtensionRow[] {
  const off = new Set(disabled);
  return skills.map((s) => ({
    id: s.name,
    label: s.name,
    detail: truncate(s.description, 60),
    enabled: !off.has(s.name),
    source: s.source,
  }));
}

/** 详情列截断（面板行宽有限，超长只示意） */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export interface WriteBackOptions {
  globalConfigFile?: string;
  projectConfigFile?: string;
}

/**
 * 切换 MCP server 启用状态并写回定义层：项目配置定义了该服务（哪怕只覆盖过 enabled）就写
 * 项目层，否则写全局层；两层都没有时抛错（面板行来自配置，正常不会发生）。
 */
export async function setMcpServerEnabled(name: string, enabled: boolean, opts: WriteBackOptions = {}): Promise<void> {
  const paths = resolveConfigPaths();
  const globalFile = opts.globalConfigFile ?? paths.globalConfigFile;
  const projectFile = opts.projectConfigFile ?? paths.projectConfigFile;
  const global = await readConfigRaw(globalFile);
  const project = await readConfigRaw(projectFile);
  const projectServers = asRecord(project.mcpServers);
  const globalServers = asRecord(global.mcpServers);
  let target: Record<string, unknown>;
  let file: string;
  if (asRecord(projectServers?.[name])) {
    target = project;
    file = projectFile;
  } else if (asRecord(globalServers?.[name])) {
    target = global;
    file = globalFile;
  } else {
    throw new Error(`配置中未找到 MCP 服务 ${name}`);
  }
  const servers = { ...asRecord(target.mcpServers) };
  servers[name] = { ...asRecord(servers[name]), enabled };
  await writeConfigRaw(file, { ...target, mcpServers: servers });
}

/**
 * 切换技能启用状态并写回配置的 skills.disabled 名单（BACKEND §20 回写规则）：
 * 关闭按来源落层——项目技能写项目配置、用户技能写全局配置（关闭标记跟技能本体同层）；
 * 启用从两层名单同时移出——名单合并语义是「任一层关闭即生效」，只清来源层时另一层
 * 的旧标记会让启用静默无效。目标文件不存在时新建。
 */
export async function setSkillDisabled(
  name: string,
  disabled: boolean,
  source: "project" | "user",
  opts: WriteBackOptions = {},
): Promise<void> {
  const paths = resolveConfigPaths();
  const globalFile = opts.globalConfigFile ?? paths.globalConfigFile;
  const projectFile = opts.projectConfigFile ?? paths.projectConfigFile;
  const files = disabled ? [source === "project" ? projectFile : globalFile] : [projectFile, globalFile];
  for (const file of files) {
    const raw = await readConfigRaw(file);
    const skills = asRecord(raw.skills) ?? {};
    // 名单只接受字符串数组：存在其它形状是配置错误，抛错不静默重写（不静默吞）
    if (skills.disabled !== undefined && !Array.isArray(skills.disabled)) {
      throw new Error(`skills.disabled 配置非法（应为字符串数组）：${file}`);
    }
    const current = skills.disabled as unknown[] | undefined;
    if (disabled) {
      // 名单内的非字符串项保留原样透传（strict 校验报错，不静默吞配置错误）
      if (current?.includes(name)) continue; // 已在名单：无需重写
      await writeConfigRaw(file, { ...raw, skills: { ...skills, disabled: [...(current ?? []), name] } });
    } else {
      if (current === undefined || !current.includes(name)) continue; // 不在名单：无需重写
      await writeConfigRaw(file, {
        ...raw,
        skills: { ...skills, disabled: current.filter((n) => n !== name) },
      });
    }
  }
}

/** 基线比对出改动行（面板 Enter 应用用；纯函数便于测试）：按 id 比对启用态 */
export function diffExtensionRows(
  baseline: Array<{ id: string; enabled: boolean }>,
  rows: ExtensionRow[],
): ExtensionRow[] {
  const base = new Map(baseline.map((r) => [r.id, r.enabled]));
  return rows.filter((r) => base.get(r.id) !== undefined && base.get(r.id) !== r.enabled);
}

/** 读 config 原始 JSON；文件不存在返回 {}，解析失败抛错（坏配置不该被静默重置） */
async function readConfigRaw(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** strict 校验后写回（沿用 connect.ts 写盘风格：缩进 2 + 尾换行）；校验失败不落盘 */
async function writeConfigRaw(file: string, raw: Record<string, unknown>): Promise<void> {
  const validated = configSchema.parse(raw);
  // POSIX 权限同 connect.ts：目录 700 / 配置 600（配置含落盘 apiKey）
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(validated, null, 2) + "\n", { mode: 0o600, encoding: "utf8" });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
