/**
 * models.dev 模型目录：模型上下文窗口与输出上限的第三方来源。
 * 用户配置未手写窗口/输出上限时按此查值，兜底常量之外多一层可信来源。
 *
 * 数据分层（查找时按序取第一个可用的）：
 * 1. 本地缓存 ~/.minicode/cache/models-dev.json——运行时从 models.dev 拉取落盘，
 *    定期刷新（间隔见 REFRESH_INTERVAL_MS），刷新是后台尽力而为：失败静默保留旧数据；
 * 2. 内置离线快照 src/llm/models-dev.json——仓库随版本携带，无缓存（首次启动/离线）时兜底；
 *    更新快照：重新下载 https://models.dev/api.json 覆盖该文件即可。
 *
 * 只在配置缺字段时代查目录值，不回写用户配置（存量配置不回填）；值原样使用，
 * 不做单位换算（目录数值以 token 计）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCacheDir } from "../config/paths.js";

/** 目录查询结果：仅返回查到的字段，都未命中返回 undefined */
export interface ModelLimits {
  contextWindow?: number;
  maxTokens?: number;
}

/** 目录查询函数签名（装配层按 provider+model 查；可注入替身做测试） */
export type CatalogLookup = (providerId: string, modelId: string) => ModelLimits | undefined;

/** 目录拉取地址（models.dev 的全量 JSON） */
const CATALOG_URL = "https://models.dev/api.json";
/** 缓存新鲜期：过期即触发一次后台刷新（不阻塞查找，查到的旧数据本轮继续用） */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 拉取超时 ms：目录请求不该拖慢启动后的首轮回合 */
const FETCH_TIMEOUT_MS = 10_000;

/** 目录 JSON 的消费字段（其余字段原样保留在文件里，此处只读 limit） */
type RawCatalog = Record<string, { models?: Record<string, { limit?: { context?: unknown; output?: unknown } }> }>;

/** 依赖注入（测试换缓存路径/快照路径/假 fetch/时钟） */
interface CatalogDeps {
  cacheFile: string;
  snapshotFile: string;
  fetchImpl: typeof fetch;
  now: () => number;
  refreshIntervalMs: number;
}

let deps: CatalogDeps = {
  cacheFile: path.join(resolveCacheDir(), "models-dev.json"),
  snapshotFile: fileURLToPath(new URL("./models-dev.json", import.meta.url)),
  fetchImpl: (url, init) => fetch(url, init),
  now: () => Date.now(),
  refreshIntervalMs: REFRESH_INTERVAL_MS,
};

/** 测试注入依赖；传 undefined 恢复默认并清空已加载数据 */
export function setCatalogDeps(partial?: Partial<CatalogDeps>): void {
  if (partial === undefined) {
    deps = {
      cacheFile: path.join(resolveCacheDir(), "models-dev.json"),
      snapshotFile: fileURLToPath(new URL("./models-dev.json", import.meta.url)),
      fetchImpl: (url, init) => fetch(url, init),
      now: () => Date.now(),
      refreshIntervalMs: REFRESH_INTERVAL_MS,
    };
    loaded = false;
    loadedCatalog = undefined;
    loadedMtime = undefined;
    refreshInFlight = undefined;
    return;
  }
  deps = { ...deps, ...partial };
  loaded = false;
  loadedCatalog = undefined;
  loadedMtime = undefined;
  refreshInFlight = undefined;
}

let loaded = false;
let loadedCatalog: RawCatalog | undefined;
let loadedMtime: number | undefined;
let refreshInFlight: Promise<void> | undefined;

/**
 * 查询某厂商某模型的窗口与输出上限：本地缓存优先（可能是刷新后的新数据），
 * 无缓存或缓存损坏回落内置快照。每次查找都核对缓存文件：缓存过期即后台刷新，
 * 缓存被刷新写新（本进程或别的进程）即重读——长驻进程多次装配（/connect、/model
 * 重装配）之间也能吃到新数据，不用常驻定时器。
 * @param providerId 目录侧厂商键（与 models.dev 的 provider 键对齐，预设经 catalogId 映射）
 * @param modelId 模型 id（目录键，与厂商请求 id 一致）
 */
export function lookupModelLimits(providerId: string, modelId: string): ModelLimits | undefined {
  const catalog = ensureLoaded();
  const model = catalog?.[providerId]?.models?.[modelId];
  if (!model) return undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  const contextWindow = num(model.limit?.context);
  const maxTokens = num(model.limit?.output);
  if (contextWindow === undefined && maxTokens === undefined) return undefined;
  return { contextWindow, maxTokens };
}

/** 加载目录数据：首次从磁盘（缓存文件 → 内置快照）；已加载后核对缓存 mtime，
 *  文件被刷新写新则重读（读失败保留已加载的旧数据），随后按需后台刷新 */
function ensureLoaded(): RawCatalog | undefined {
  const mtime = cacheMtime();
  if (loaded) {
    if (mtime !== loadedMtime) {
      try {
        const parsed = JSON.parse(fs.readFileSync(deps.cacheFile, "utf8")) as RawCatalog;
        loadedCatalog = parsed;
        loadedMtime = mtime;
      } catch {
        // 缓存此刻读不出（被并发替换中间态等）：保留已加载的旧数据，下次查找重试
      }
    }
    maybeRefresh();
    return loadedCatalog;
  }
  loaded = true;
  loadedMtime = mtime;
  if (mtime !== undefined) {
    try {
      loadedCatalog = JSON.parse(fs.readFileSync(deps.cacheFile, "utf8")) as RawCatalog;
    } catch (err) {
      // 缓存文件存在但解析失败（半截/损坏）：删掉让下个进程重拉；缺失（ENOENT）不用删。
      // 本次回落内置快照
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        try {
          fs.unlinkSync(deps.cacheFile);
        } catch {
          // 删不掉不影响后续（下次启动重试）
        }
      }
      loadedCatalog = loadSnapshot();
    }
  } else {
    loadedCatalog = loadSnapshot();
  }
  maybeRefresh();
  return loadedCatalog;
}

function loadSnapshot(): RawCatalog | undefined {
  try {
    return JSON.parse(fs.readFileSync(deps.snapshotFile, "utf8")) as RawCatalog;
  } catch {
    // 快照也读不出（异常构建产物）：目录来源缺席，调用方按兜底常量走
    return undefined;
  }
}

/** 缓存文件 mtime（ms）；缺失/不可读返回 undefined */
function cacheMtime(): number | undefined {
  try {
    return fs.statSync(deps.cacheFile).mtimeMs;
  } catch {
    return undefined;
  }
}

/** 缓存过期或缺失时发起一次后台刷新；刷新已在途则不重复发起 */
function maybeRefresh(): void {
  if (refreshInFlight) return;
  if (cacheFresh()) return;
  refreshInFlight = refresh()
    .catch(() => {
      // 刷新失败静默：旧缓存/快照继续可用，下个进程再试
    })
    .finally(() => {
      refreshInFlight = undefined;
    });
}

/** 缓存文件是否在新鲜期内（读 mtime，文件缺失/不可读视为过期） */
function cacheFresh(): boolean {
  try {
    const mtime = fs.statSync(deps.cacheFile).mtimeMs;
    return deps.now() - mtime < deps.refreshIntervalMs;
  } catch {
    return false;
  }
}

/** 拉取目录并原子落盘：先写临时文件再改名，中断不产生半截缓存 */
async function refresh(): Promise<void> {
  const res = await deps.fetchImpl(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return;
  const text = await res.text();
  const parsed = JSON.parse(text) as RawCatalog;
  if (typeof parsed !== "object" || parsed === null || Object.keys(parsed).length === 0) return;
  const tmp = `${deps.cacheFile}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(deps.cacheFile), { recursive: true });
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, deps.cacheFile);
  // 本次查找仍用已加载的旧数据（查找方持一致快照完成本轮装配）；
  // 新缓存由下一次查找核对 mtime 后热加载
}
