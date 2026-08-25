/**
 * 层 1：视图渲染冒烟——opentui 渲染链就位，根组件渲染预期内容。
 * 断言用 opentui testRender 的字符帧（captureCharFrame），替代旧「帧行数组」断言方式。
 */
import { testRender } from "@opentui/solid";
import { describe, it, expect } from "vitest";
import { App } from "../../src/tui/view/App.js";
import { createChannel } from "../../src/tui/loop.js";

describe("view/App 渲染链", () => {
  it("根组件渲染出界面骨架内容", async () => {
    const channel = createChannel([]);
    const setup = await testRender(
      () => (
        <App state={channel.state} model="test-model" sessionId="abc123" onAction={channel.onAction} />
      ),
      { width: 80, height: 10 },
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("test-model");
    expect(frame).toContain("● 空闲");
  });
});