import type { ContextModifier } from "./base.js";

/**
 * 并发安全分区：按具体输入判断的并发安全，把工具调用切成批次。
 * 批内可并发，批间严格串行，保持模型输出的调用顺序。
 */

export interface ConcurrencyItem {
  /** 调用原始序号 */
  index: number;
  /** 是否并发安全（按具体输入判断，调用方提供；拿不准按 false） */
  isConcurrencySafe: boolean;
}

export interface ConcurrencyBatch {
  /** 批内调用序号 */
  indices: number[];
  /** 该批是否并发批（全部并发安全，可并行执行） */
  concurrent: boolean;
}

/**
 * 贪心单趟分区：并发安全调用聚合到一批，不安全调用单独成批。
 * @param items 按原始顺序排列的调用（含并发安全判定）
 * @returns 批次数组，批间保持原顺序
 */
export function partitionByConcurrency(items: ConcurrencyItem[]): ConcurrencyBatch[] {
  const batches: ConcurrencyBatch[] = [];
  for (const item of items) {
    const last = batches.at(-1);
    if (item.isConcurrencySafe && last && last.concurrent) {
      last.indices.push(item.index);
    } else {
      batches.push({ indices: [item.index], concurrent: item.isConcurrencySafe });
    }
  }
  return batches;
}

/** 单个调用执行结果：除业务输出外可携带上下文修改，供批末统一应用 */
export interface ExecuteOutcome {
  /** 该调用产出的上下文修改；无修改时省略 */
  contextModifier?: ContextModifier;
}

export interface RunBatchesOptions {
  /** 批内并发上限，默认 10 */
  concurrencyLimit?: number;
  /**
   * 批结束后按声明顺序逐个回调，应用该批工具产出的上下文修改。
   * 回调在整批所有调用完成后触发，index 为批内声明序号。
   */
  onContextModifier?: (modifier: ContextModifier, index: number) => void;
}

/**
 * 按批执行：并发批内限并发执行，非并发批串行；批间严格顺序。
 * 每个批内全部调用结束后，按声明顺序统一应用该批产出的上下文修改。
 * @param batches 分区结果
 * @param executeOne 执行单个调用（按序号），可返回产出的上下文修改
 * @param options 执行选项（并发上限、上下文修改应用回调）
 */
export async function runBatches(
  batches: ConcurrencyBatch[],
  executeOne: (index: number) => Promise<ExecuteOutcome | void>,
  options: RunBatchesOptions = {},
): Promise<void> {
  const limit = options.concurrencyLimit ?? 10;
  for (const batch of batches) {
    const outcomes =
      batch.concurrent && batch.indices.length > 1
        ? await runWithLimit(batch.indices, executeOne, limit)
        : await runSerially(batch.indices, executeOne);
    applyContextModifiers(batch.indices, outcomes, options.onContextModifier);
  }
}

/**
 * 有界并发：每次最多并发执行 limit 个，收集各调用的上下文修改。
 * @param indices 批内调用序号
 * @param executeOne 执行单个调用
 * @param limit 同时执行上限
 * @returns 批内各序号产出的上下文修改（无产出的不收录）
 */
async function runWithLimit(
  indices: number[],
  executeOne: (index: number) => Promise<ExecuteOutcome | void>,
  limit: number,
): Promise<Map<number, ExecuteOutcome>> {
  const outcomes = new Map<number, ExecuteOutcome>();
  for (let i = 0; i < indices.length; i += limit) {
    const chunk = indices.slice(i, i + limit);
    const results = await Promise.all(
      chunk.map(async (index) => ({ index, outcome: await executeOne(index) })),
    );
    for (const { index, outcome } of results) {
      if (outcome?.contextModifier) outcomes.set(index, outcome);
    }
  }
  return outcomes;
}

/**
 * 串行执行：逐项 await（中途失败即中止，不启动后续调用），收集上下文修改。
 * @param indices 批内调用序号
 * @param executeOne 执行单个调用
 * @returns 批内各序号产出的上下文修改（无产出的不收录）
 */
async function runSerially(
  indices: number[],
  executeOne: (index: number) => Promise<ExecuteOutcome | void>,
): Promise<Map<number, ExecuteOutcome>> {
  const outcomes = new Map<number, ExecuteOutcome>();
  for (const index of indices) {
    const outcome = await executeOne(index);
    if (outcome?.contextModifier) outcomes.set(index, outcome);
  }
  return outcomes;
}

/**
 * 按声明顺序统一应用一批工具产出的上下文修改。
 * @param indices 批内声明顺序的序号
 * @param outcomes 各序号产出的上下文修改
 * @param onContextModifier 应用回调；未提供则整批修改被丢弃（调用方不关心上下文）
 */
function applyContextModifiers(
  indices: number[],
  outcomes: Map<number, ExecuteOutcome>,
  onContextModifier?: (modifier: ContextModifier, index: number) => void,
): void {
  if (!onContextModifier) return;
  for (const index of indices) {
    const modifier = outcomes.get(index)?.contextModifier;
    if (modifier) onContextModifier(modifier, index);
  }
}
