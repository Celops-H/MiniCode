import { createReadStream } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { resolveSessionsDir } from "../config/paths.js";
import { TRACE_FORMAT, type TraceEventLine, type TraceHeader, type TraceMessageLine } from "./format.js";

/**
 * 轨迹读取的通用原语：流式逐行扫描、按 kind/event/agentPath
 * 过滤、容错反序列化。TUI 的累计重建与工具耗时回填是它的两个内置消费方（B4）；
 * 指标聚合口径不进本模块，留在消费侧（评测）。
 *
 * 容错规则：未知 kind / event 跳过不报错——事件类型是开放
 * 清单，前向兼容靠这条，新增事件类型老读者零改动；损坏行同样跳过（宁丢一行
 * 不拖垮整体，与会话 JSONL 坏行处理一致）。
 */
export class TraceReader {
  /**
   * 读轨迹首行 header；文件不存在、首行损坏或 format 不符返回 undefined
   * （惰性清理据此对无法定位的轨迹保守跳过，宁可残留不误删）。
   * 流式只读首行：惰性清理对目录内每个轨迹调用本方法，重度用户轨迹目录大，
   * 全量读盘只为取首行不划算。
   */
  static async readHeader(filePath: string): Promise<TraceHeader | undefined> {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        try {
          const parsed = JSON.parse(line) as { format?: unknown };
          if (parsed.format !== TRACE_FORMAT) return undefined;
          return parsed as TraceHeader;
        } catch {
          return undefined; // 首行损坏：视为无法定位的轨迹
        }
      }
      return undefined; // 空文件
    } catch {
      return undefined; // 文件不存在等读错误
    } finally {
      rl.close();
      stream.close();
    }
  }

  /**
   * 流式逐行扫描轨迹（header 之外的消息行与事件行）：逐行反序列化并按 kind 分流，
   * 损坏行与未知 kind 跳过。
   * @param filePath 轨迹文件路径
   */
  static async *lines(filePath: string): AsyncGenerator<TraceMessageLine | TraceEventLine> {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      let isFirst = true;
      for await (const line of rl) {
        if (isFirst) {
          isFirst = false; // 首行是 header，不在数据行之列
          continue;
        }
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // 损坏行跳过
        }
        if (typeof parsed !== "object" || parsed === null) continue;
        const record = parsed as Record<string, unknown>;
        if (record.kind === "message" && typeof record.id === "string") {
          yield record as unknown as TraceMessageLine;
        } else if (record.kind === "event" && typeof record.event === "string") {
          // 容错反序列化：形状由 kind 门检查，字段级缺失交给消费方按可选处理
          yield record as unknown as TraceEventLine;
        }
        // 其余 kind（未知/未来版本）跳过不报错：前向兼容
      }
    } finally {
      rl.close();
      stream.close();
    }
  }

  /**
   * 流式扫描事件行，可按 event 名称与 agentPath 过滤（消费方取子集的便捷入口）。
   * @param filePath 轨迹文件路径
   * @param filter 过滤条件（字段可省略，省略即不过滤该维度）
   */
  static async *events(
    filePath: string,
    filter: { event?: string; agentPath?: string } = {},
  ): AsyncGenerator<TraceEventLine> {
    for await (const line of TraceReader.lines(filePath)) {
      if (line.kind !== "event") continue;
      if (filter.event !== undefined && line.event !== filter.event) continue;
      if (filter.agentPath !== undefined && line.agentPath !== filter.agentPath) continue;
      yield line;
    }
  }
}

/**
 * 删除会话对应的轨迹文件（会话删除联动的唯一联动点）。
 * 调用方约定先轨迹后会话：即使两步之间崩溃，残留只会是「有会话无轨迹」的无害方向，
 * 不会留下含正文的孤儿轨迹。文件不存在时静默通过（force）。
 * @param tracesDir 轨迹目录
 * @param sessionId 会话 id
 */
export async function deleteTrace(tracesDir: string, sessionId: string): Promise<void> {
  await rm(path.join(tracesDir, `${sessionId}.jsonl`), { force: true });
}

/**
 * 惰性清理（兜底）：按各轨迹 header 的 cwd 定位对应会话目录，
 * 会话文件已不存在的轨迹直接删除——防历史版本（轨迹目录早于按 cwd 隔离的会话
 * 存储使用）或意外路径残留。读取失败/头损坏的轨迹保守跳过，宁可残留不误删。
 * 该 cwd 的会话子目录本身不存在时整体跳过（如 sessionsDir 换根后新根尚未建）——
 * 该根的会话布局未知，防止把全部旧轨迹当孤儿误删（轨迹含消息正文不可恢复）。
 * @param tracesDir 轨迹目录
 * @param sessionsRoot 会话存储根目录（各轨迹按 header.cwd 派生自己的会话目录）
 * @param keepSessionId 当前活跃会话（草稿会话尚未落盘，其轨迹不能误删）
 * @returns 删除的轨迹文件数
 */
export async function cleanupStaleTraces(
  tracesDir: string,
  sessionsRoot: string,
  keepSessionId: string,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(tracesDir);
  } catch {
    return 0; // 轨迹目录不存在（从未写过轨迹）或不可读：无残留可清
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    if (sessionId === keepSessionId) continue;
    const filePath = path.join(tracesDir, name);
    const header = await TraceReader.readHeader(filePath);
    if (!header) continue;
    const sessionsDir = resolveSessionsDir({ root: sessionsRoot, cwd: header.cwd });
    try {
      await stat(sessionsDir);
    } catch {
      // 会话子目录不存在：布局未知，保守跳过（换根守卫，见函数注释）
      continue;
    }
    try {
      await stat(path.join(sessionsDir, `${sessionId}.jsonl`));
    } catch {
      // 目录在而会话文件缺：删除残留轨迹
      await rm(filePath, { force: true });
      removed++;
    }
  }
  return removed;
}
