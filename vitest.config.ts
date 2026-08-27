/**
 * vitest 配置：Solid JSX（vite-plugin-solid 编译，generate universal + moduleName @opentui/solid，
 * 对齐 opentui solid-transform）+ tsx 测试文件纳入 + node 测试环境（TUI 非浏览器）。
 * opentui 的 FFI（--experimental-ffi，Node ≥ 26.4）由 package.json test 脚本经 cross-env NODE_OPTIONS
 * 注入——环境变量对主进程与 vitest worker（独立 node 子进程）都生效，vitest 4 已无 poolOptions.execArgv。
 */
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import path from "node:path";

/**
 * 统一 solid-js 到客户端单实例：vite-node/vitest 走 SSR（node 条件），"solid-js" 会解析到
 * dist/server.js（SSR 版，signal 不调度），而 opentui/solid import "solid-js/dist/solid.js"
 * （客户端版）——两套实例导致 createSignal 与 reconciler 的 render-effect 不互通，界面不刷新。
 * opencode 的 bun preload 也是把 server.js 替换成 solid.js（同因）。这里 alias 全部指向
 * 客户端版（solid.js / store.js），保证组件与 opentui reconciler 共享同一实例。
 */
const solidJsEntry = path.resolve(import.meta.dirname, "node_modules/solid-js/dist/solid.js");
const solidStoreEntry = path.resolve(import.meta.dirname, "node_modules/solid-js/store/dist/store.js");

export default defineConfig({
  plugins: [
    solid({
      solid: {
        generate: "universal",
        moduleName: "@opentui/solid",
      },
    }),
  ],
  resolve: {
    alias: [
      { find: /^solid-js\/store(\/.*)?$/, replacement: solidStoreEntry },
      { find: /^solid-js(\/.*)?$/, replacement: solidJsEntry },
    ],
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    // 全局准备（tests/setup.ts）：压测试环境下 process 监听器累积超限的警告刷屏
    setupFiles: ["tests/setup.ts"],
  },
  // 与 vite.config 的 noExternal 保持一致：统一 solid-js 单实例（组件与 @opentui/solid 共享，
  // 否则 store 更新驱动不了 reconciler 渲染），TUI 回归测试依赖此配置
  ssr: {
    noExternal: ["solid-js", "@opentui/solid"],
  },
});