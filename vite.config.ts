/**
 * TUI 运行时构建配置（重写后；dev:tui 用 vite-node 读取编译）。
 * Solid JSX 由 vite-plugin-solid（babel-preset-solid）编译——Solid 响应式模板必须经 preset 编译。
 * 配置对齐 opentui 官方 solid-transform（scripts/solid-transform.js）：generate "universal"（非 DOM）
 * + moduleName "@opentui/solid"（模板 helper 从 opentui 导入）。dom 模式会编译到 solid-js/web
 * （node 下 document 缺失）；universal + moduleName 才是 opentui runtime 的正确路径。
 * opentui FFI（--experimental-ffi，Node ≥ 26.4）由 package.json 的 dev/dev:tui 脚本经 cross-env
 * NODE_OPTIONS 注入；生产入口由 dist/bin/minicode.js 包装重启注入（见 src/bin/minicode.ts）。
 * 测试走 vitest.config.ts（vitest 优先读独立配置）。
 */
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import path from "node:path";

/**
 * 统一 solid-js 到客户端单实例：dev:tui（vite-node）走 SSR（node 条件），"solid-js" 会解析到
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
  // TUI 生产构建（⑤minicode tui build）：SSR bundle src/tui/index.tsx → dist/tui/index.js，
  // 由 tsc 编译出的 CLI（dist/cli/app.js）dynamic import 接管 `minicode tui`。
  // solid-js/@opentui/solid 打进 bundle（alias 单实例），其余依赖（@opentui/core 含原生 FFI
  // 子包、openai/commander/zod 与 node 内建）保持 external 走常规 node_modules 解析。
  ...(process.env.VITE_TUI_BUILD
    ? {
        build: {
          ssr: "src/tui/index.tsx",
          outDir: "dist/tui",
          emptyOutDir: true,
          rollupOptions: {
            output: { format: "esm", entryFileNames: "index.js" },
            external: [/^node:/, /^@opentui\/core/, "openai", "commander", "zod"],
          },
        },
      }
    : {}),
  // node:ffi 是 Node 26 新增实验内建，vite 8 解析器未把它当 node 内建 external，
  // 需显式标注，否则 dev:tui（vite-node）加载 win32.ts 报 Cannot find package 'node:ffi'
  ssr: {
    external: ["node:ffi"],
    // noExternal solid-js 与 @opentui/solid：vite-node 默认把 node_modules 外置给 Node 原生加载，
    // 造成「组件 alias 加载的 solid-js」与「@opentui/solid 原生加载的 solid-js」两个实例不互通，
    // store 更新不驱动界面重渲。一起进 vite 转换 = 同一模块注册表 = 单实例。
    noExternal: ["solid-js", "@opentui/solid"],
  },
});