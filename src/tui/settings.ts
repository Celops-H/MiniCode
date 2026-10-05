/**
 * /settings 设置面板：功能开关的行定义、生效值读取与配置回写。
 * 全部开关为装配期读取，应用后走重装配链生效（同 /model）。
 * 回写规则「写回定义层」：开关字段被项目配置定义过就写项目层 .minicode.json，否则写全局
 * ~/.minicode/config.json（两层都无时写全局）。嵌套字段（compact.enabled 等）按父对象判定——
 * 配置合并是顶层键后级整体覆盖前级，父对象在项目层时只写全局会被整个顶掉、开关静默无效。
 * 写盘风格与 extensions.ts 一致：改原始 JSON → strict schema 校验 → mkdir 700 + 缩进 2 写回 + 0o600。
 * 失败不抛进程：错误由 loop 展示 toast。
 */
import { resolveConfigPaths } from "../config/paths.js";
import type { Config } from "../config/index.js";
import { readConfigRaw, writeConfigRaw, type WriteBackOptions, type ExtensionRow } from "./extensions.js";

/** 设置开关定义（面板行与回写定位共用；id 为配置定位键，嵌套字段用「父.叶」） */
export interface SettingSpec {
  id: string;
  label: string;
  detail: string;
  /** 配置未定义时的生效值（缺省开/关，与装配层缺省一致） */
  defaultValue: boolean;
}

/** 首轮列项（均为布尔开关；logLevel 为枚举型不进面板） */
export const SETTING_SPECS: SettingSpec[] = [
  {
    id: "modelChainEnabled",
    label: "优先级链",
    detail: "模型出错时按优先级链自动切备选（链成员与顺序在配置文件 modelChain 编辑）",
    defaultValue: true,
  },
  {
    id: "compact.enabled",
    label: "撞线自动压缩",
    detail: "上下文接近窗口上限时自动压缩历史（/compact 手动不受限）",
    defaultValue: true,
  },
  {
    id: "memory",
    label: "会话记忆",
    detail: "每轮后台增量维护会话记忆，压缩时替代现场摘要",
    defaultValue: false,
  },
  {
    id: "worktrees",
    label: "子 agent worktree 隔离",
    detail: "派生子 agent 在独立 git worktree 中工作，可按任务逐次选择",
    defaultValue: true,
  },
  {
    id: "agents",
    label: "多 Agent 协作",
    detail: "允许模型派生子 agent 并行协作（--no-agents 等效）",
    defaultValue: true,
  },
  {
    id: "observability.enabled",
    label: "运行轨迹落盘",
    detail: "会话运行轨迹写入 ~/.minicode/traces",
    defaultValue: true,
  },
  {
    id: "debug.streamChunks",
    label: "流解析调试",
    detail: "记录流解析中被丢弃的 chunk 到 stderr（诊断用）",
    defaultValue: false,
  },
];

/** 读开关生效值（合并后配置；未定义或形状非布尔回落缺省值）：如 "compact.enabled" → config.compact?.enabled */
export function settingValue(config: Config | undefined, spec: SettingSpec): boolean {
  let current: unknown = config;
  for (const key of spec.id.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return spec.defaultValue;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "boolean" ? current : spec.defaultValue;
}

/** /settings 面板行：各项开关按合并配置的生效值展示（缺省行也展示，切换后写回才有落层依据） */
export function buildSettingsRows(config?: Config): ExtensionRow[] {
  return SETTING_SPECS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    detail: spec.detail,
    enabled: settingValue(config, spec),
  }));
}

/**
 * 切换设置开关并写回定义层：嵌套字段看父对象是否被项目层定义（定义过写项目层，
 * 否则写全局；两层都无时写全局）；标量字段看字段本身是否被项目层定义。
 * @param id 开关定位键（SETTING_SPECS 之外抛错，防误写任意配置路径）
 */
export async function setSettingEnabled(id: string, enabled: boolean, opts: WriteBackOptions = {}): Promise<void> {
  const spec = SETTING_SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`未知的设置项 ${id}`);
  const paths = resolveConfigPaths();
  const globalFile = opts.globalConfigFile ?? paths.globalConfigFile;
  const projectFile = opts.projectConfigFile ?? paths.projectConfigFile;
  const global = await readConfigRaw(globalFile);
  const project = await readConfigRaw(projectFile);
  const dot = id.indexOf(".");
  const topKey = dot < 0 ? id : id.slice(0, dot);
  const leafKey = dot < 0 ? undefined : id.slice(dot + 1);
  const projectDefines =
    leafKey !== undefined ? isPlainObject(project[topKey]) : project[topKey] !== undefined;
  const target = projectDefines ? project : global;
  const file = projectDefines ? projectFile : globalFile;
  if (leafKey === undefined) {
    target[topKey] = enabled;
  } else {
    target[topKey] = { ...asRecord(target[topKey]), [leafKey]: enabled };
  }
  await writeConfigRaw(file, target);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}
