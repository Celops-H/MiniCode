/**
 * TUI 独立启动入口（pnpm run dev:tui）：无条件引导 runTuiEntry。
 * vite-node 直接运行本文件；不用 import.meta.url===argv[1] 检测（vite-node 转换路径下不成立）。
 * CLI 的 `minicode tui` 命令（src/cli/app.ts）当前依赖 build 产物含 TUI（Solid 构建链待接入），
 * 开发与真机验证走本入口。
 */
import { runTuiEntry } from "./index.js";

void runTuiEntry({}).catch((err) => {
  console.error(`TUI 启动失败：${(err as Error).message}`);
  process.exit(1);
});