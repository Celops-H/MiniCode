/**
 * TUI 独立启动入口（pnpm run dev:tui）：无条件引导 runTuiEntry。
 * vite-node 直接运行本文件；不用 import.meta.url===argv[1] 检测（vite-node 转换路径下不成立）。
 * CLI 的 `minicode tui` 走 src/cli/app.ts 的懒加载 import（不触发本文件）。
 */
import { runTuiEntry } from "./index.js";

void runTuiEntry({}).catch((err) => {
  console.error(`TUI 启动失败：${(err as Error).message}`);
  process.exit(1);
});