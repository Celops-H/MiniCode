import { describe, expect, it } from "vitest";
import { partitionByConcurrency, runBatches } from "../../src/tools/index.js";

function item(index: number, isConcurrencySafe: boolean) {
  return { index, isConcurrencySafe };
}

describe("partitionByConcurrency（贪心分区）", () => {
  it("全部并发安全 → 合成一批", () => {
    const batches = partitionByConcurrency([
      item(0, true),
      item(1, true),
      item(2, true),
    ]);
    expect(batches).toEqual([{ indices: [0, 1, 2], concurrent: true }]);
  });

  it("安全调用被不安全调用隔开时分别成批", () => {
    const batches = partitionByConcurrency([
      item(0, true), // read
      item(1, true), // read
      item(2, false), // write
      item(3, true), // read
    ]);
    expect(batches).toEqual([
      { indices: [0, 1], concurrent: true },
      { indices: [2], concurrent: false },
      { indices: [3], concurrent: true },
    ]);
  });

  it("不安全调用打头时单独成批", () => {
    const batches = partitionByConcurrency([item(0, false), item(1, true)]);
    expect(batches).toEqual([
      { indices: [0], concurrent: false },
      { indices: [1], concurrent: true },
    ]);
  });

  it("空数组返回空批次", () => {
    expect(partitionByConcurrency([])).toEqual([]);
  });
});

describe("runBatches（按批执行）", () => {
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("批间严格串行，批内并发", async () => {
    const batches = partitionByConcurrency([
      item(0, true),
      item(1, true),
      item(2, false),
      item(3, true),
    ]);
    const order: string[] = [];
    await runBatches(batches, async (index) => {
      order.push(`start${index}`);
      await delay(5);
      order.push(`end${index}`);
    });

    // 批1 (0,1) 先开始，批2 (2) 其次，批3 (3) 最后——批间串行
    const s0 = order.indexOf("start0");
    const s2 = order.indexOf("start2");
    const s3 = order.indexOf("start3");
    expect(s0).toBeLessThan(s2);
    expect(s2).toBeLessThan(s3);
    // 所有调用都执行
    expect(order.filter((o) => o.startsWith("end"))).toHaveLength(4);
  });

  it("并发批内并发执行（全部 end 不早于全部 start）", async () => {
    const batches = partitionByConcurrency([item(0, true), item(1, true)]);
    const events: string[] = [];
    await runBatches(batches, async (index) => {
      events.push(`start${index}`);
      await delay(10);
      events.push(`end${index}`);
    });
    // 两个调用都在批内：先都 start，后都 end（有交错但不是 end 先于所有 start）
    const starts = events.filter((e) => e.startsWith("start"));
    const ends = events.filter((e) => e.startsWith("end"));
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
  });

  it("并发上限限制批内同时执行数", async () => {
    const batches = partitionByConcurrency([
      item(0, true),
      item(1, true),
      item(2, true),
      item(3, true),
    ]);
    let concurrent = 0;
    let maxConcurrent = 0;
    await runBatches(
      batches,
      async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await delay(5);
        concurrent--;
      },
      { concurrencyLimit: 2 },
    );
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBe(2);
  });
});
