/**
 * FFI 重启判定与命令行组装（bin 包装入口的纯函数部分）：TUI 的 opentui 渲染依赖 Node 原生 FFI，
 * 需要以 --experimental-ffi 启动（Node ≥ 26.4）。拆出纯函数便于层 1 测试直调，
 * 避免为测决策点直接 import 包装入口触发真实重启。
 */

export const FFI_FLAG = "--experimental-ffi";

/**
 * 当前进程是否需要重启注入 FFI flag。
 * 注意 execArgv 只反映命令行注入的参数：用户已设 NODE_OPTIONS 时能力已具备但这里仍判「需要」，
 * 会多做一次重启（flag 幂等、无害），换来检测逻辑单一可测。
 */
export function needsFfiRestart(execArgv: readonly string[]): boolean {
  return !execArgv.includes(FFI_FLAG);
}

/**
 * 组装重启后的命令行参数：保留既有 execArgv 参数（如内存上限等用户设置），
 * 追加 FFI flag，其后接脚本路径与原始用户参数（argv[0] 是 node 自身，slice(1) 起才是有效内容）。
 */
export function restartCommandArgv(execArgv: readonly string[], argv: readonly string[]): string[] {
  return [...execArgv, FFI_FLAG, ...argv.slice(1)];
}
