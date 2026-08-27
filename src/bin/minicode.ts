#!/usr/bin/env node
/**
 * minicode 可执行入口：TUI 的 opentui 渲染依赖 Node 原生 FFI，需要以 --experimental-ffi 启动
 * （Node ≥ 26.4）。shebang 无法携带 flag，Windows 的 npm shim 也不经 shebang——当前进程没带该
 * flag 时按原参数重启自身（stdio 直通、定向信号转发、退出码对齐），加载 FFI 能力后再进正常入口。
 */
import { spawn } from "node:child_process";
import { needsFfiRestart, restartCommandArgv } from "./ffi.js";

/** 已具备 FFI 能力：调 CLI 入口的 main（app.ts 仅直跑时自启 main，包装入口需显式调用） */
async function run(): Promise<void> {
  const app = await import("../cli/app.js");
  await app.main();
}

if (!needsFfiRestart(process.execArgv)) {
  await run().catch((err: unknown) => {
    console.error(`启动失败：${(err as Error).message}`);
    process.exit(1);
  });
} else {
  const child = spawn(process.execPath, restartCommandArgv(process.execArgv, process.argv), {
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  // 定向信号转发：进程管理器可能只结束包装进程，子进程不跟随会持 TTY 成孤儿。
  // 终端 Ctrl+C 在 TUI raw mode 下是子进程自己的按键输入，不走这里
  const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const forwarders = new Map<string, () => void>();
  for (const signal of forwardedSignals) {
    const forwarder = (): void => {
      try {
        child.kill(signal);
      } catch {
        // 子进程可能已退出，忽略
      }
    };
    forwarders.set(signal, forwarder);
    process.on(signal, forwarder);
  }
  child.on("error", (err) => {
    console.error(`启动失败：${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    for (const [sig, forwarder] of forwarders) process.removeListener(sig as NodeJS.Signals, forwarder);
    if (signal) {
      try {
        // 以同信号结束本进程，shell 看到的退出方式与子进程一致；平台不支持时按失败收尾
        process.kill(process.pid, signal);
        return;
      } catch {
        process.exit(1);
      }
    }
    process.exit(code ?? 0);
  });
}
