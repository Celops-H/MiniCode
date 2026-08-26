/**
 * 层 1 回归：store 更新必须反映到界面输出。
 * 对应真机「输入不刷新」历史 bug：早期结论是「store 更新了但画面不变」。headless 实测定位为
 * 诊断期 stderr 噪声在 raw+备用屏污染显示所致（渲染链本身正常）。本测试钉住两条链路：
 *  1. App 完整树经 testRender：store 更新 → 字符帧出现输入字符（alias/noExternal 统一实例的正向保障）
 *  2. 真实 CliRenderer + mock 流（headless，绕 setupTerminal 不挂起）：真实渲染循环输出的
 *     字节直接包含输入字符（真机输入显示路径的回归防线）
 */
import { testRender } from "@opentui/solid";
import { render } from "@opentui/solid";
import { CliRenderer } from "@opentui/core";
import { it, expect } from "vitest";
import { App } from "../../src/tui/view/App.js";
import { createChannel } from "../../src/tui/loop.js";
import { initState, reduceAction, type TuiState } from "../../src/tui/state.js";
import { createStore, reconcile } from "solid-js/store";

/** 假终端流：记录所有 write 字节（CliRenderer useThread:false 时 writeOut 落到注入的 stdout） */
class FakeStream {
  isTTY = true;
  columns = 60;
  rows = 14;
  written: Uint8Array[] = [];
  constructor(public readonly isInput: boolean) {}
  write(chunk: Uint8Array | string, _enc?: string, cb?: () => void): boolean {
    this.written.push(chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk)));
    cb?.();
    return true;
  }
  on(_ev: string, _fn: (...args: unknown[]) => void): this {
    return this;
  }
  once(_ev: string, _fn: (...args: unknown[]) => void): this {
    return this;
  }
  emit(_ev: string, ..._args: unknown[]): boolean {
    return true;
  }
  removeListener(): this {
    return this;
  }
  setRawMode(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

const asciiOf = (chunks: Uint8Array[]): string =>
  chunks.map((c) => Array.from(c).map((b) => String.fromCharCode(b)).join("")).join("");

it("完整 App（testRender）：store 更新后输入框出现输入字符", async () => {
  const channel = createChannel([]);
  const setup = await testRender(
    () => <App state={channel.state} model="m" onAction={channel.onAction} />,
    { width: 40, height: 8 },
  );
  await setup.waitForVisualIdle();
  channel.onAction({ type: "input", text: "hi" });
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("hi");
});

it("真实 CliRenderer（headless mock 流）：store 更新后输出字节含输入字符", async () => {
  const mockOut = new FakeStream(false);
  const renderer = new CliRenderer(new FakeStream(true) as never, mockOut as never, 60, 14, {
    exitOnCtrlC: false,
    useThread: false,
    targetFps: 60,
    autoFocus: false,
    openConsoleOnError: false,
    gatherStats: false,
  } as never);
  try {
    const [state, setState] = createStore<TuiState>(initState([]));
    const commit = (next: TuiState): void => setState(reconcile(next));
    const onAction = (action: Parameters<typeof reduceAction>[1]): void => {
      commit(reduceAction(state, action));
    };
    await render(() => <App state={state} model="m" onAction={onAction} />, renderer as never);
    // 等首帧绘出
    await new Promise((r) => setTimeout(r, 200));
    const before = mockOut.written.length;
    onAction({ type: "input", text: "abc" });
    await new Promise((r) => setTimeout(r, 300));
    // 更新后应有新的 write，且累计输出字节里出现 a/b/c（0x61/0x62/0x63）
    expect(mockOut.written.length).toBeGreaterThan(before);
    expect(asciiOf(mockOut.written)).toContain("abc");
  } finally {
    try {
      renderer.destroy();
    } catch {
      // 已销毁等
    }
  }
}, 10000);