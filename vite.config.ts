/**
 * TUI 运行时构建配置（重写后新增；dev:tui 用 vite-node 读取编译）。
 * 渲染层用 opentui/solid（Solid JSX 自定义元素 box/text/scrollbox…），vite 8 底层用 oxc 转译，
 * JSX 经 oxc.jsx（runtime/importSource）指向 @opentui/solid 的 jsx-runtime。
 * opentui FFI（--experimental-ffi，Node ≥ 26.4）由 package.json dev:tui 脚本经 cross-env NODE_OPTIONS 注入。
 * 测试走 vitest.config.ts（vitest 优先读独立配置；此处只管 vite-node 运行时转换）。
 */
import { defineConfig } from "vite";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "@opentui/solid",
    },
  },
});