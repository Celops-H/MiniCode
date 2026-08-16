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

export interface RunBatchesOptions {
  /** 批内并发上限，默认 10 */
  concurrencyLimit?: number;
}

/**
 * 按批执行：并发批内限并发执行，非并发批串行；批间严格顺序。
 * @param batches 分区结果
 * @param executeOne 执行单个调用（按序号）
 * @param options 执行选项（并发上限）
 */
export async function runBatches(
  batches: ConcurrencyBatch[],
  executeOne: (index: number) => Promise<unknown>,
  options: RunBatchesOptions = {},
): Promise<void> {
  const limit = options.concurrencyLimit ?? 10;
  for (const batch of batches) {
    if (batch.concurrent && batch.indices.length > 1) {
      await runWithLimit(batch.indices, executeOne, limit);
    } else {
      for (const index of batch.indices) {
        await executeOne(index);
      }
    }
  }
}

/** 有界并发：每次最多并发执行 limit 个 */
async function runWithLimit(
  indices: number[],
  executeOne: (index: number) => Promise<unknown>,
  limit: number,
): Promise<void> {
  for (let i = 0; i < indices.length; i += limit) {
    const chunk = indices.slice(i, i + limit);
    await Promise.all(chunk.map((index) => executeOne(index)));
  }
}
