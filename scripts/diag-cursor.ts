/**
 * E134 诊断脚本：验证光标定位转义（CUP）的写出行为。
 * 每个阶段在独立子进程里跑（同一进程内连续创建渲染器会互相干扰：后一个
 * 渲染器每帧全量重绘，空闲帧读数失真）。
 *
 * 阶段一（diff 帧）：setCursorPosition 与参数 visible 各组合下，帧输出是否多出目标定位转义；
 * 阶段二（空闲帧）：内容不变连续渲染，逐帧核对是否有字节写出。
 *
 * 已实证（headless 测试渲染器，2026-10-05，见 request.md E134 条目）：
 * - 空闲帧（无内容 diff）不向终端写任何字节；
 * - 目标定位转义只在 visible=true 时写出；visible=false 只发隐藏转义、不写位置。
 *   与能力位无关：JS 侧 setRendererCapabilities 置位对输出无影响。
 * 字节到达比 renderOnce 迟一拍，读数前留沉降窗（150-200ms）。
 *
 * 运行方式：pnpm diag:cursor
 */
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer, setRendererCapabilities } from "@opentui/core/testing";

const log = (s: string): void => {
  writeSync(2, `${s}\n`);
};
const cupOf = (s: string): string[] => s.match(/\x1b\[\d+;\d+H/g) ?? [];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 一次捕获：PassThrough 收渲染器 stdout 字节，read 取走并清零 */
function makeCapture(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => {
    chunks.push(c);
  });
  return {
    stream,
    read: () => {
      const s = Buffer.concat(chunks).toString("utf8");
      chunks.length = 0;
      return s;
    },
  };
}

type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

async function makeRenderer(): Promise<{ setup: Setup; read: () => string }> {
  const { stream, read } = makeCapture();
  const setup = await createTestRenderer({
    width: 40,
    height: 10,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stdout: stream as unknown as NodeJS.WriteStream,
    // 自定义 stdout 经 NativeSpanFeed 回放原始字节（"memory" 只留内存缓冲，捕获不到）
    bufferedOutput: "stdout",
  });
  return { setup, read };
}

/** 挂内容与可选的光标定位，跑若干帧；visible 为 setCursorPosition 的第三参 */
async function buildScene(
  explicitCursor: boolean,
  useSetCursor: boolean,
  visible = false,
): Promise<{ setup: Setup; read: () => string }> {
  const { setup, read } = await makeRenderer();
  setRendererCapabilities(setup.renderer, { explicit_cursor_positioning: explicitCursor });
  if (useSetCursor) {
    setup.renderer.addPostProcessFn(() => {
      setup.renderer.setCursorPosition(10, 5, visible);
    });
  }
  const ctx = setup.renderer.root.ctx;
  setup.renderer.root.add(new TextRenderable(ctx, { content: "x" }));
  return { setup, read };
}

/** 阶段一：内容帧写出与转义清单 */
async function phaseDiff(
  label: string,
  explicitCursor: boolean,
  useSetCursor: boolean,
  visible = false,
): Promise<void> {
  const { setup, read } = await buildScene(explicitCursor, useSetCursor, visible);
  for (let i = 0; i < 3; i++) {
    await setup.renderOnce();
    await sleep(200);
  }
  const all = read();
  log(
    `[${label}] 总字节=${all.length} CUP总数=${cupOf(all).length} 含目标定位(5;10)=${all.includes("\x1b[5;10H")} 含帧尾回(1;1)=${all.includes("\x1b[1;1H")}`,
  );
  log(`  CUP 明细：${JSON.stringify(cupOf(all))}`);
  setup.renderer.stop();
  setup.renderer.destroy();
}

/** 阶段二：逐帧读数（稳定段 + 空闲段） */
async function phaseIdle(label: string, explicitCursor: boolean): Promise<void> {
  const { setup, read } = await buildScene(explicitCursor, true);
  log(`[${label}]`);
  for (let i = 0; i < 2; i++) {
    await setup.renderOnce();
    await sleep(200);
    const r = read();
    log(`  稳定帧${i + 1}: 字节=${r.length} CUP=${cupOf(r).length}`);
  }
  for (let i = 0; i < 6; i++) {
    await setup.renderOnce();
    await sleep(150);
    const r = read();
    log(`  空闲帧${i + 1}: 字节=${r.length} CUP=${cupOf(r).length}`);
  }
  setup.renderer.stop();
  setup.renderer.destroy();
}

type Phase = () => Promise<void>;

const PHASES: Record<string, Phase> = {
  "diff-base-on": () => phaseDiff("①基线(cap on)", true, false),
  "diff-set-on": () => phaseDiff("①定位 visible=false(cap on)", true, true),
  "diff-set-visible-on": () => phaseDiff("①定位 visible=true(cap on)", true, true, true),
  "diff-base-off": () => phaseDiff("①基线(cap off)", false, false),
  "diff-set-off": () => phaseDiff("①定位 visible=false(cap off)", false, true),
  "diff-set-visible-off": () => phaseDiff("①定位 visible=true(cap off)", false, true, true),
  "idle-on": () => phaseIdle("②空闲(cap on)", true),
  "idle-off": () => phaseIdle("②空闲(cap off)", false),
};

async function main(): Promise<number> {
  const phaseName = process.argv[2];
  if (phaseName) {
    const phase = PHASES[phaseName];
    if (!phase) {
      log(`未知阶段：${phaseName}（可用：${Object.keys(PHASES).join("、")}）`);
      return 1;
    }
    await phase();
    return 0;
  }
  // 无参数：逐阶段起独立子进程（同进程多渲染器互相干扰，读数不可靠）
  const scriptPath = fileURLToPath(import.meta.url);
  let failed = 0;
  for (const name of Object.keys(PHASES)) {
    const result = spawnSync(process.execPath, [...process.execArgv, scriptPath, name], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.status !== 0) failed++;
  }
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    log(`诊断脚本失败：${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
