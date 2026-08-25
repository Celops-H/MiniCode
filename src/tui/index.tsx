/**
 * TUI 入口：复用 cli/app 装配，嵌 opentui 渲染器渲染 Solid 组件树。
 * R0 只验证渲染链就位；interact 接入与完整交互在后续块（loop.ts 重写）实现。
 */
import { render } from "@opentui/solid";
import { App } from "./view/App.js";

async function main(): Promise<void> {
  await render(() => <App />, {});
}

void main();