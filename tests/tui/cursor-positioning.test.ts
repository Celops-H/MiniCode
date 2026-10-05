/**
 * 层 1：硬件光标定位接线（E134）。
 * 契约两条：
 * ① 位置必须按 visible=true 调 setCursorPosition——opentui 只在 visible=true 时写出定位转义，
 *    visible=false 只发隐藏转义、不写位置，输入法候选窗便锚不到输入框光标处；
 * ② 帧末（frame 事件，原生帧写出之后）补发 DECTCEM 隐藏转义，保证同帧内最后生效的是隐藏，
 *    硬件光标不显示，光标格仍留在输入框处。
 * 真实渲染器一例核对实际字节顺序，替身一例钉住接线契约。
 */
import { PassThrough } from "node:stream";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { attachCursorPositioning, tuiCursor, type CursorRenderer } from "../../src/tui/cursor.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  tuiCursor.row = 1;
  tuiCursor.col = 1;
});

describe("硬件光标定位接线", () => {
  it("帧输出含目标定位转义，且帧尾以隐藏转义收束", async () => {
    const chunks: Buffer[] = [];
    const out = new PassThrough();
    out.on("data", (c: Buffer) => chunks.push(c));
    const setup = await createTestRenderer({
      width: 40,
      height: 12,
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      stdout: out as unknown as NodeJS.WriteStream,
      // 自定义 stdout 经 NativeSpanFeed 回放原始字节（"memory" 捕获不到）
      bufferedOutput: "stdout",
    });
    attachCursorPositioning(setup.renderer as unknown as CursorRenderer, (chunk) => {
      out.write(chunk);
    });
    tuiCursor.row = 7;
    tuiCursor.col = 9;
    const ctx = setup.renderer.root.ctx;
    setup.renderer.root.add(new TextRenderable(ctx, { content: "x" }));
    await setup.renderOnce();
    await sleep(250);
    const bytes = Buffer.concat(chunks).toString("utf8");
    chunks.length = 0;

    // 目标定位转义按 (row;col) 写出，即硬件光标落在输入框光标处
    expect(bytes).toContain("\x1b[7;9H");
    // 定位之后有隐藏转义，且全帧最后一条可见性转义是隐藏（visible=true 会先发显示转义）
    const target = bytes.lastIndexOf("\x1b[7;9H");
    expect(bytes.slice(target)).toContain("\x1b[?25l");
    expect(bytes.lastIndexOf("\x1b[?25l")).toBeGreaterThan(bytes.lastIndexOf("\x1b[?25h"));
    setup.renderer.stop();
    setup.renderer.destroy();
  });

  it("postProcess 每帧请求定位，frame 事件补发隐藏", () => {
    const postFns: Array<() => void> = [];
    const listeners: Array<() => void> = [];
    const written: string[] = [];
    const renderer: CursorRenderer = {
      addPostProcessFn: (fn) => postFns.push(fn),
      on: (_event, listener) => listeners.push(listener),
      setCursorPosition: (x, y, visible) => {
        written.push(`pos:${x},${y},${String(visible)}`);
      },
    };
    attachCursorPositioning(renderer, (chunk) => written.push(`raw:${chunk}`));
    expect(postFns).toHaveLength(1);
    expect(listeners).toHaveLength(1);

    tuiCursor.row = 3;
    tuiCursor.col = 5;
    postFns[0]!();
    expect(written).toEqual(["pos:5,3,true"]);

    listeners[0]!();
    expect(written[1]).toBe("raw:\x1b[?25l");
  });

  it("active=false（光标不归输入框管，如 connect key 弹窗态）：postProcess 不写定位", () => {
    const postFns: Array<() => void> = [];
    const written: string[] = [];
    const renderer: CursorRenderer = {
      addPostProcessFn: (fn) => postFns.push(fn),
      on: () => {},
      setCursorPosition: (x, y, visible) => {
        written.push(`pos:${x},${y},${String(visible)}`);
      },
    };
    attachCursorPositioning(renderer, () => {});
    tuiCursor.row = 3;
    tuiCursor.col = 5;
    tuiCursor.active = false;
    postFns[0]!();
    expect(written).toEqual([]);
    // 恢复掌管后照常定位
    tuiCursor.active = true;
    postFns[0]!();
    expect(written).toEqual(["pos:5,3,true"]);
  });
});
