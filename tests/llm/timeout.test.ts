import { describe, expect, it } from "vitest";
import { withIdleTimeout } from "../../src/llm/providers/timeout.js";

/** 挂死流：产出给定 chunk 后既不结束也不响应中断（厂商握着连接不发结束帧也不关流） */
function stalledStream<T>(chunks: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
      await new Promise<void>(() => undefined);
    },
  };
}

const isTailChunk = (chunk: unknown): boolean => chunk === "stop_reason";

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = [];
  for await (const chunk of stream) seen.push(chunk);
  return seen;
}

describe("withIdleTimeout 收尾宽限分支", () => {
  it("命中收尾 chunk 后源不再产出也不结束：宽限窗耗尽按正常收尾结束，不报超时", async () => {
    const idleCalls: number[] = [];
    const t0 = Date.now();
    const seen = await drain(
      withIdleTimeout(stalledStream(["head", "stop_reason"]), 20, () => idleCalls.push(1), {
        isTailChunk,
        tailGraceMs: 120,
      }),
    );
    const elapsed = Date.now() - t0;
    // 已产出的 chunk 全部透出，宽限窗耗尽正常结束（不抛「模型响应超时」丢整轮）
    expect(seen).toEqual(["head", "stop_reason"]);
    // 宽限窗耗尽同样中断底层请求，释放厂商握着的挂连接；只中断一次
    expect(idleCalls).toHaveLength(1);
    // 结束点落在宽限窗末：计时已切到宽限窗，20ms 的空闲超时未生效
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it("宽限窗内源再来新数据：不提前关流，数据照常透出后正常结束", async () => {
    async function* source(): AsyncIterable<string> {
      yield "stop_reason";
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      yield "补发";
    }
    const idleCalls: number[] = [];
    const seen = await drain(withIdleTimeout(source(), 20, () => idleCalls.push(1), {
      isTailChunk,
      tailGraceMs: 120,
    }));
    expect(seen).toEqual(["stop_reason", "补发"]);
    expect(idleCalls).toEqual([]);
  });

  it("未命中收尾 chunk 时空闲超时：中断底层请求并抛「模型响应超时」", async () => {
    const idleCalls: number[] = [];
    const seen: unknown[] = [];
    await expect(async () => {
      for await (const chunk of withIdleTimeout(stalledStream(["head"]), 20, () => idleCalls.push(1), {
        isTailChunk,
        tailGraceMs: 120,
      })) {
        seen.push(chunk);
      }
    }).rejects.toThrow(/模型响应超时/);
    expect(seen).toEqual(["head"]);
    expect(idleCalls).toEqual([1]);
  });
});
