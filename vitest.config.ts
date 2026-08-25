/**
 * vitest 配置：Solid JSX（vite-plugin-solid 编译，generate universal + moduleName @opentui/solid，
 * 对齐 opentui solid-transform）+ tsx 测试文件纳入 + node 测试环境（TUI 非浏览器）。
 * opentui 的 FFI（--experimental-ffi，Node ≥ 26.4）由 package.json test 脚本经 cross-env NODE_OPTIONS
 * 注入——环境变量对主进程与 vitest worker（独立 node 子进程）都生效，vitest 4 已无 poolOptions.execArgv。
 */
import { defineConfig } from "vitest/config";
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
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});