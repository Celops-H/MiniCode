/**
 * TUI 入口（重写版）：装配界面通道并渲染根视图。
 * R1a 为演示装配（空历史/模型名占位）；R1b 起接入 cli 装配（config/会话/agent/interact）。
 */
import { render } from "@opentui/solid";
import { App } from "./view/App.js";
import { createChannel } from "./loop.js";

async function main(): Promise<void> {
  const channel = createChannel([]);
  await render(
    () => <App state={channel.state} model="MiniCode" sessionId="demo" onAction={channel.onAction} />,
    {},
  );
}

void main();