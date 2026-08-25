/**
 * 层 1：视图渲染冒烟——opentui 渲染链就位，根组件输出预期内容。
 * 断言用 opentui testRender 的字符帧（captureCharFrame），替代旧「帧行数组」断言方式。
 */
import { testRender } from "@opentui/solid";
import { describe, it, expect } from "vitest";
import { App } from "../../src/tui/view/App.js";

describe("view/App 渲染链", () => {
  it("根组件渲染出标题文本", async () => {
    const setup = await testRender(() => <App />, { width: 40, height: 5 });
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("MiniCode TUI");
  });
});