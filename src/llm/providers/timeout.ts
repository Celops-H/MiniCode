/** 请求超时（ms）：厂商慢/挂起时不再无限等待——超时抛错走路由切换或错误渲染；
 *  25s 覆盖正常模型首 token 延迟，不可达厂商（如 openai.com 在部分网络）快速判死路由，
 *  不再干等一分钟（用户对齐 2026-08-26） */
export const REQUEST_TIMEOUT_MS = 25_000;

/** 流空闲超时（ms）：厂商断流/网络中断、N 秒无新 chunk 时中断并报错（SDK timeout 不覆盖流式响应体读取） */
export const STREAM_IDLE_TIMEOUT_MS = 30_000;

/** 收尾宽限窗（ms，E47）：停止原因（finish_reason / stop_reason）已到即响应逻辑完整，
 *  个别厂商此后握着连接不发结束帧也不关流——宽限窗内无新数据按正常收尾关流
 *  （协议以已收到的停止原因收 done），不再按超时报错丢整轮 */
export const TAIL_GRACE_TIMEOUT_MS = 10_000;

/** 收尾宽限配置（E47）：isTailChunk 判定「响应逻辑完成」的原始 chunk（各协议自行识别停止原因），
 *  命中后空闲计时切换为 tailGraceMs，宽限窗耗尽按正常收尾关流而不是报超时 */
export interface IdleTailOptions {
  isTailChunk: (chunk: unknown) => boolean;
  tailGraceMs: number;
}

/** 收尾关流哨兵：宽限窗耗尽时从 deadline 侧发出，主循环据此正常退出迭代 */
const TAIL_CLOSED = Symbol("收尾关流");

type IdleRaceOutcome<T> = IteratorResult<T> | typeof TAIL_CLOSED;

/**
 * 流空闲超时包装：底层流 N 秒无产出（厂商 SSE 静默挂起、网络中断但连接不关）时，
 * 触发 onIdle 中断底层请求并抛「模型响应超时」错误——SDK 的 timeout 只覆盖响应头，
 * 读流式 body 无超时，这里补上，防正常运行期无限挂起（真机「卡住不返回」根因）。
 * 收尾宽限（E47）：命中 tail.isTailChunk 的 chunk 之后响应已逻辑完成，空闲计时切换为
 * tail.tailGraceMs；宽限耗尽同样触发 onIdle 释放底层挂连接，但按正常收尾关流（不抛错），
 * 协议层以已收到的停止原因收 done，整轮不丢。
 * 中断不碰用户 signal：用户打断语义（interrupt）由调用方处理，二者不互相污染。
 * 各协议 Provider 共用（openai-compatible / anthropic-compatible）。
 * @param source 底层事件流（parseStream 的产出）
 * @param idleMs 空闲超时（无新 chunk 的容忍窗口）
 * @param onIdle 超时触发的中断回调（abort 底层请求，让挂起的读取尽快释放）
 * @param tail 收尾宽限配置；缺省无宽限（命中不了收尾态，行为与旧版一致）
 * @returns 包装后的流
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  onIdle: () => void,
  tail?: IdleTailOptions,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  let timer: NodeJS.Timeout | undefined;
  // 停止原因已到 → 收尾态：后续空闲等待切换为宽限窗
  let inTail = false;
  try {
    while (true) {
      const next = iterator.next();
      // 防 unhandled rejection：onIdle 中断底层后，挂起的 next 可能 reject（本处不 await 它）
      next.catch(() => undefined);
      const outcome = new Promise<IdleRaceOutcome<T>>((resolve, reject) => {
        timer = setTimeout(() => {
          onIdle();
          // 收尾宽限窗耗尽：响应已完整，关流收尾（哨兵 resolve），不报超时
          if (inTail) {
            resolve(TAIL_CLOSED);
            return;
          }
          reject(new Error(`模型响应超时：${idleMs / 1000} 秒未收到新数据（厂商断流或网络中断）`));
        }, inTail ? tail!.tailGraceMs : idleMs);
      });
      const result = await Promise.race([next, outcome]);
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (result === TAIL_CLOSED) return;
      if (result.done) return;
      if (tail?.isTailChunk(result.value)) inTail = true;
      yield result.value;
    }
  } finally {
    if (timer) clearTimeout(timer);
    timer = undefined;
    // 不等待 return：永挂流（await 永不 settle）的 return() 也永不完成，等待会把收尾卡死；
    // 触发清理但不等结果，底层流正常时自会释放
    iterator.return?.().catch(() => undefined);
  }
}
