import { readFile } from "node:fs/promises";
import { configSchema, type Config } from "./types.js";
import { resolveConfigPaths, type ConfigPaths } from "./paths.js";

export interface LoadConfigOptions {
  /** 配置文件路径（测试可注入） */
  paths?: ConfigPaths;
  /** 环境变量（测试可注入） */
  env?: NodeJS.ProcessEnv;
}

/**
 * 加载配置：默认值 < 全局配置 < 项目配置 < 环境变量，逐级覆盖合并。
 * 校验失败（非法字段 / 格式错误）直接抛出。
 * @param opts 加载选项（paths / env 可注入，测试用）
 * @returns 合并并校验后的配置
 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<Config> {
  const paths = opts.paths ?? resolveConfigPaths();
  const env = opts.env ?? process.env;

  const defaults = configSchema.parse({});
  const globalRaw = await readJsonFile(paths.globalConfigFile);
  const projectRaw = await readJsonFile(paths.projectConfigFile);
  const envRaw = pickEnvConfig(env);

  return configSchema.parse(mergeConfigLayers([defaults, globalRaw, projectRaw, envRaw]));
}

/**
 * 逐级合并配置来源：顶层键后级覆盖前级；三个例外——
 * providers 按 id 归并（同 id 后级覆盖、不同 id 都保留），避免项目 .minicode.json
 * 把全局配置里 /connect 新加的供应商整体顶掉；
 * mcpServers 按服务名归并（同服务名后级覆盖整个条目、不同名都保留），语义同 providers；
 * skills.disabled 两层名单取并集（关闭即关闭，不分层覆盖）。
 * 任一层相应字段形状非法，视为非法整体透传，交给 schema strict 校验报错（不静默吞）。
 */
function mergeConfigLayers(layers: Array<Record<string, unknown> | null>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const providerById = new Map<string, unknown>();
  const serverByName = new Map<string, unknown>();
  const disabledSkills = new Set<string>();
  let providersInvalid: unknown;
  let mcpServersInvalid: unknown;
  let skillsInvalid: unknown;
  for (const layer of layers) {
    if (!layer) continue;
    const providers = layer.providers;
    if (Array.isArray(providers)) {
      // 已有非法 providers 层时不再归并后续层，直接把非法值透传出去等 schema 报错
      if (providersInvalid === undefined) {
        for (const p of providers) {
          const id = (p as { id?: unknown } | null | undefined)?.id;
          if (typeof id !== "string") {
            providersInvalid = providers;
            break;
          }
          providerById.set(id, p);
        }
      }
    } else if (providers !== undefined) {
      providersInvalid = providers;
    }
    const mcpServers = layer.mcpServers;
    if (isPlainObject(mcpServers)) {
      // 已有非法 mcpServers 层时同 providers：停止归并，非法值整体透传
      if (mcpServersInvalid === undefined) {
        for (const [name, cfg] of Object.entries(mcpServers)) {
          if (!isPlainObject(cfg)) {
            mcpServersInvalid = mcpServers;
            break;
          }
          serverByName.set(name, cfg);
        }
      }
    } else if (mcpServers !== undefined) {
      mcpServersInvalid = mcpServers;
    }
    const skills = layer.skills;
    if (isPlainObject(skills)) {
      const disabled = skills.disabled;
      if (disabled === undefined) {
        // skills 只有 disabled 一个合法键；出现其他键即拼错字段，透传给 schema 报错（不静默吞）
        if (Object.keys(skills).length > 0 && skillsInvalid === undefined) {
          skillsInvalid = skills;
        }
      } else if (Array.isArray(disabled)) {
        // 已有非法 skills 层时同 providers：停止归并，非法值整体透传
        if (skillsInvalid === undefined) {
          for (const name of disabled) {
            if (typeof name !== "string") {
              skillsInvalid = skills;
              break;
            }
            disabledSkills.add(name);
          }
        }
      } else if (disabled !== undefined) {
        skillsInvalid = skills;
      }
    } else if (skills !== undefined) {
      skillsInvalid = skills;
    }
    for (const [key, value] of Object.entries(layer)) {
      if (key === "providers" || key === "mcpServers" || key === "skills") continue;
      result[key] = value;
    }
  }
  if (providersInvalid !== undefined) {
    result.providers = providersInvalid;
  } else if (providerById.size > 0) {
    result.providers = [...providerById.values()];
  }
  if (mcpServersInvalid !== undefined) {
    result.mcpServers = mcpServersInvalid;
  } else if (serverByName.size > 0) {
    result.mcpServers = Object.fromEntries(serverByName);
  }
  if (skillsInvalid !== undefined) {
    result.skills = skillsInvalid;
  } else if (disabledSkills.size > 0) {
    result.skills = { disabled: [...disabledSkills] };
  }
  return result;
}

/** 是否普通对象（非 null、非数组） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取并解析 JSON 文件。
 * @param file 文件路径
 * @returns 解析出的对象；文件不存在返回 null，解析失败或非对象抛出
 */
async function readJsonFile(file: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    // 文件不存在视为没有该级配置源
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const data: unknown = JSON.parse(text);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`配置文件格式错误（应为 JSON 对象）：${file}`);
  }
  return data as Record<string, unknown>;
}

/**
 * 从环境变量提取 MINICODE_* 配置项，下划线转驼峰。
 * @param env 环境变量对象
 * @returns 驼峰键 → 值的映射
 */
function pickEnvConfig(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("MINICODE_") && value !== undefined) {
      const name = key
        .slice("MINICODE_".length)
        .toLowerCase()
        .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      result[name] = value;
    }
  }
  return result;
}
