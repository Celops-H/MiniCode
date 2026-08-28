/** 请求超时（ms）：厂商慢/挂起时不再无限等待——超时抛错走路由切换或错误渲染；
 *  25s 覆盖正常模型首 token 延迟，不可达厂商（如 openai.com 在部分网络）快速判死路由，
 *  不再干等一分钟（用户对齐 2026-08-26） */
export const REQUEST_TIMEOUT_MS = 25_000;

/** 流空闲超时（ms）：厂商断流/网络中断、N 秒无新 chunk 时中断并报错（SDK timeout 不覆盖流式响应体读取） */
export const STREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * 流空闲超时包装：底层流 N 秒无产出（厂商 SSE 静默挂起、网络中断但连接不关）时，
 * 触发 onIdle 中断底层请求并抛「模型响应超时」错误——SDK 的 timeout 只覆盖响应头，
 * 读流式 body 无超时，这里补上，防正常运行期无限挂起（真机「卡住不返回」根因）。
 * 中断不碰用户 signal：用户打断语义（interrupt）由调用方处理，二者不互相污染。
 * 各协议 Provider 共用（openai-compatible / anthropic-compatible）。
 * @param source 底层事件流（parseStream 的产出）
 * @param idleMs 空闲超时（无新 chunk 的容忍窗口）
 * @param onIdle 超时触发的中断回调（abort 底层请求，让挂起的读取尽快释放）
 * @returns 包装后的流
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  onIdle: () => void,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  let timer: NodeJS.Timeout | undefined;
  try {
    while (true) {
      const next = iterator.next();
      // 防 unhandled rejection：onIdle 中断底层后，挂起的 next 可能 reject（本处不 await 它）
      next.catch(() => undefined);
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onIdle();
          reject(new Error(`模型响应超时：${idleMs / 1000} 秒未收到新数据（厂商断流或网络中断）`));
        }, idleMs);
      });
      const result = await Promise.race([next, deadline]);
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (result.done) return;
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
