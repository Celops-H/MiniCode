/**
 * TUI 运行时构建配置（重写后；dev:tui 用 vite-node 读取编译）。
 * Solid JSX 由 vite-plugin-solid（babel-preset-solid）编译——Solid 响应式模板必须经 preset 编译。
 * 配置对齐 opentui 官方 solid-transform（scripts/solid-transform.js）：generate "universal"（非 DOM）
 * + moduleName "@opentui/solid"（模板 helper 从 opentui 导入）。dom 模式会编译到 solid-js/web
 * （node 下 document 缺失）；universal + moduleName 才是 opentui runtime 的正确路径。
 * opentui FFI（--experimental-ffi，Node ≥ 26.4）由 package.json dev:tui 脚本经 cross-env NODE_OPTIONS 注入。
 * 测试走 vitest.config.ts（vitest 优先读独立配置）。
 */
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [
    solid({
      solid: {
        generate: "universal",
        moduleName: "@opentui/solid",
      },
    }),
  ],
});