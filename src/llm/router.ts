/**
 * 判断错误是否属于「可切换」类（DESIGN 5.2）：
 * 路由遇到这类错误时计数并切换到备选模型；反之（参数/认证/权限等确定性错误）
 * 不计数、直接上抛，切换也无济于事。
 * 分类依据：429（限流）/5xx（服务器）/408（请求超时）/409（锁冲突）/无 HTTP 状态
 * （网络、连接、超时）→ 可切换；400/401/403/404 → 直接报错。
 * status 用 duck-typing 提取，不依赖具体 SDK 错误类型（各厂商错误均带 status 属性）。
 * @param error 捕获的错误对象
 * @returns 是否可切换
 */
export function isSwitchableError(error: unknown): boolean {
  const status = (error as { status?: number } | null | undefined)?.status;
  if (status === undefined) return true; // 无 HTTP 状态：网络/连接/超时错误，可切换
  if (status === 408 || status === 409 || status === 429) return true; // 超时/冲突/限流
  if (status >= 500) return true; // 服务器内部错误
  return false; // 参数、认证、权限、模型不存在等确定性错误
}
