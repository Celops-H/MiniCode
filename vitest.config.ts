/**
 * vitest 配置：Solid JSX（opentui/solid）转换 + tsx 测试文件纳入。
 * vite 8 底层用 oxc 转译，JSX 经 oxc.jsx（runtime/importSource）指向 @opentui/solid 的 jsx-runtime。
 * opentui 的 FFI（--experimental-ffi，Node ≥ 26.4）由 package.json test 脚本经 cross-env NODE_OPTIONS
 * 注入——环境变量对主进程与 vitest worker（独立 node 子进程）都生效，vitest 4 已无 poolOptions.execArgv。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "@opentui/solid",
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});