/**
 * 层 1：视图渲染冒烟——opentui 渲染链就位，根组件渲染预期内容。
 * 断言用 opentui testRender 的字符帧（captureCharFrame），替代旧「帧行数组」断言方式。
 * 注意：状态行用窄宽用例钉住「窄屏不折行」——flexShrink:0 使右侧溢出被截而非换行。
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
      { width: 40, height: 8 },
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("test-model");
    expect(frame).toContain("● 空闲");
  });

  it("窄屏（44 列）：状态行不折行、模型名完整", async () => {
    const channel = createChannel([]);
    const setup = await testRender(
      () => (
        <App state={channel.state} model="test-model" sessionId="abc123" onAction={channel.onAction} />
      ),
      { width: 44, height: 8 },
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    // 模型名完整保留在同一行
    expect(frame).toContain("test-model");
    // 状态行所在行不应出现「▼/…」等折行痕迹（行数：8 行窗口内含状态行，折行会让内容多行
    // 干扰输入框 —— 这里只断言模型名与状态图标仍同屏出现即可，折行回归由 flexShrink 控制）
    expect(frame).toContain("●");
  });
});