import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 文件版本令牌（DESIGN 7.6）：read 记录、write/edit 校验。
 * mtime+size 对齐覆盖「同一毫秒两次写入」盲区；完整读时记录内容 hash，
 * 供「mtime 变但内容未变」的抖动场景兜底放行。
 */
export interface FileVersion {
  mtimeMs: number;
  size: number;
  /** 仅完整读时可得；部分读为 undefined */
  contentHash?: string;
}

/** 计算文件内容的 sha256 哈希 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 模块级 per-path 锁：跨 FileState（多 agent）共享，串行化同路径的「校验+写入+刷新」 */
const fileLocks = new Map<string, Promise<void>>();

/** 按 agent 隔离的文件状态：磁盘是共享真相，先到先写天然成立（DESIGN 7.6） */
export class FileState {
  private readonly versions = new Map<string, FileVersion>();

  private normalize(p: string): string {
    // Windows 文件系统大小写不敏感：统一小写，避免 C:\a.txt 与 c:\A.TXT 各占锁/快照条目绕过 CAS
    const resolved = resolvePath(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  getVersion(p: string): FileVersion | undefined {
    return this.versions.get(this.normalize(p));
  }

  setVersion(p: string, version: FileVersion): void {
    this.versions.set(this.normalize(p), version);
  }

  /**
   * per-path 进程内异步锁：串行化「校验 + 写入 + 刷新快照」，关闭 TOCTOU 窗口。
   * 锁是模块级共享（跨 FileState / 多 agent），否则各 agent 各自持锁不互斥，
   * 并发写同一文件时后写者仍可能静默覆盖。同路径并发写排队，不同路径互不阻塞。
   */
  async withFileLock<T>(p: string, fn: () => Promise<T>): Promise<T> {
    const key = this.normalize(p);
    const prev = fileLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => next);
    fileLocks.set(key, tail);
    // 链尾完成即清理：key 无继续排队就删，防长会话 Map 无限膨胀；期间有新尾巴则不删
    void tail.then(() => {
      if (fileLocks.get(key) === tail) fileLocks.delete(key);
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 校验磁盘现状 vs 快照，判定是否可写（CAS 语义）。
   * - 无快照（从未读过）：新建/覆盖语义，可写
   * - mtime+size 未变：可写
   * - mtime 变但 size 一致且完整读 hash 一致：抖动（编辑器 touched、杀软扫描）兜底放行
   * - 其余：文件已被修改，拒绝
   * @param p 文件路径
   * @returns 拒绝原因；null 表示可写
   */
  async assertWritable(p: string): Promise<string | null> {
    const version = this.getVersion(p);
    if (!version) return null;
    const disk = await stat(this.normalize(p));
    if (disk.mtimeMs === version.mtimeMs && disk.size === version.size) return null;
    if (disk.size === version.size && version.contentHash !== undefined) {
      const content = await readFile(this.normalize(p), "utf8");
      if (hashContent(content) === version.contentHash) return null;
    }
    return "文件已被外部或其他 Agent 修改，请重新 Read 后再写";
  }

  /** 写入成功后刷新版本（在锁内调用），只刷自己这份快照 */
  async refreshVersion(p: string, content: string): Promise<void> {
    const disk = await stat(this.normalize(p));
    this.setVersion(p, {
      mtimeMs: disk.mtimeMs,
      size: disk.size,
      contentHash: hashContent(content),
    });
  }
}

/** 当前 agent 的文件状态：Agent 执行工具时经 AsyncLocalStorage 绑定到本次工具执行的异步链 */
const stateStore = new AsyncLocalStorage<FileState>();

/** 当前工具执行上下文的 cwd：Agent 指定工作目录时经 AsyncLocalStorage 绑定；缺省进程 cwd */
const cwdStore = new AsyncLocalStorage<string>();

/** 在当前工具执行上下文中记录/校验文件版本；无 agent 上下文时返回 undefined */
export function currentFileState(): FileState | undefined {
  return stateStore.getStore();
}

/** 把一次工具执行的异步链绑定到指定 FileState（Agent 在 executeTool 调用处使用） */
export async function withFileState<T>(state: FileState, fn: () => T | Promise<T>): Promise<T> {
  return stateStore.run(state, fn);
}

/** 当前工具执行的工作目录（Agent 指定 cwd 时返回之，否则进程 cwd） */
export function currentCwd(): string {
  return cwdStore.getStore() ?? process.cwd();
}

/** 把一次工具执行的异步链绑定到指定工作目录（Agent 在 executeTool 调用处使用） */
export async function withCwd<T>(cwd: string, fn: () => T | Promise<T>): Promise<T> {
  return cwdStore.run(cwd, fn);
}

/**
 * 按当前工具执行上下文解析路径：绝对路径原样，相对路径基于当前 cwd。
 * 工具统一经此解析用户输入的路径（Worktree 场景下子 agent 的 cwd 是独立工作区）。
 */
export function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(currentCwd(), p);
}