/**
 * vitest 全局准备：测试反复创建 TUI 渲染器，opentui 的 TerminalConsoleCache 每次构造都在自身
 * EventEmitter 上挂一组 "entry" 监听且无移除逻辑，单个实例内累积超默认上限（10）触发
 * MaxListenersExceededWarning 刷屏。生产进程只创建一次渲染器不会出现；这里放宽测试进程中
 * 未显式设上限的 EventEmitter 默认值（0=不限），只压噪音不改断言行为。
 *
 * 另：模型目录默认指向不存在的缓存文件并拒绝网络请求——测试进程不读用户真实缓存、
 * 不发真实目录刷新请求；快照仍指向真实文件，目录查询行为与生产一致。
 */
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { setCatalogDeps } from "../src/llm/catalog.js";

EventEmitter.defaultMaxListeners = 0;

setCatalogDeps({
  cacheFile: path.join(os.tmpdir(), `minicode-test-catalog-${process.pid}.json`),
  snapshotFile: fileURLToPath(new URL("../src/llm/models-dev.json", import.meta.url)),
  fetchImpl: () => Promise.reject(new Error("测试进程不发真实目录请求")),
});

