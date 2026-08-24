import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandHook, HookBus } from "../../src/hooks/index.js";

/** 生成一个读 stdin 事件并按脚本逻辑回应的 node 命令（避免 shell 引号转义） */
function makeHookCommand(dir: string, logic: string): string {
  const script = path.join(dir, "hook.mjs");
  writeFileSync(
    script,
    `import { readFileSync } from "node:fs";\n` +
      `const input = JSON.parse(readFileSync(0, "utf8"));\n` +
      `${logic}\n`,
    "utf8",
  );
  return `node ${script}`;
}

describe("命令 hook 适配器（DESIGN 13）", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("PreToolUse：命令回 verdict 裁决", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
    const command = makeHookCommand(
      dir,
      `process.stdout.write(JSON.stringify({ verdict: "deny" }));`,
    );
    const handler = createCommandHook(command, { timeoutMs: 5000 });
    const verdict = await handler({ type: "PreToolUse", toolCallId: "t1", toolName: "bash", input: {} });
    expect(verdict).toBe("deny");
  });

  it("PreToolUse：allow / ask 透传", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
    const allow = createCommandHook(
      makeHookCommand(dir, `process.stdout.write(JSON.stringify({ verdict: "allow" }));`),
      { timeoutMs: 5000 },
    );
    expect(await allow({ type: "PreToolUse", toolCallId: "t1", toolName: "read", input: {} })).toBe("allow");
    const ask = createCommandHook(
      makeHookCommand(dir, `process.stdout.write(JSON.stringify({ verdict: "ask" }));`),
      { timeoutMs: 5000 },
    );
    expect(await ask({ type: "PreToolUse", toolCallId: "t1", toolName: "bash", input: {} })).toBe("ask");
  });

  it("PreToolUse：非零退出 / 非 JSON 输出 / 超时 → 保守 deny", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
    // 非零退出
    const failing = createCommandHook(makeHookCommand(dir, `process.exit(1);`), { timeoutMs: 5000 });
    expect(await failing({ type: "PreToolUse", toolCallId: "t1", toolName: "bash", input: {} })).toBe("deny");
    // 输出非 JSON
    const garbage = createCommandHook(makeHookCommand(dir, `process.stdout.write("hello");`), { timeoutMs: 5000 });
    expect(await garbage({ type: "PreToolUse", toolCallId: "t1", toolName: "bash", input: {} })).toBe("deny");
    // 超时（命令 sleep，超时 100ms）
    const slow = createCommandHook(
      makeHookCommand(dir, `await new Promise((r) => setTimeout(r, 1000)); process.stdout.write("late");`),
      { timeoutMs: 100 },
    );
    expect(await slow({ type: "PreToolUse", toolCallId: "t1", toolName: "bash", input: {} })).toBe("deny");
  });

  it("观测事件（PostToolUse 等）：命令被调用，返回 undefined", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
    const received = path.join(dir, "received.txt");
    const command = makeHookCommand(
      dir,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(received)}, input.hookEvent.type);`,
    );
    const handler = createCommandHook(command, { timeoutMs: 5000 });
    const result = await handler({ type: "PostToolUse", toolCallId: "t1", toolName: "read", input: {}, output: "x", isError: false });
    expect(result).toBeUndefined();
    // 命令确实执行了（stdin 收到事件）
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(received, "utf8")).toBe("PostToolUse");
  });
});

describe("HookBus 与命令装配", () => {
  it("buildHookBus 语义：config.hooks 逐事件注册命令", async () => {
    // 直接验证 createCommandHook 注册进 HookBus 后可经 emit 触发（PreToolUse 结果透出）
    const dir = mkdtempSync(path.join(os.tmpdir(), "hook-test-"));
    const command = makeHookCommand(dir, `process.stdout.write(JSON.stringify({ verdict: "deny" }));`);
    const bus = new HookBus();
    bus.on("PreToolUse", createCommandHook(command, { timeoutMs: 5000 }));
    const results = await bus.emit({ type: "PreToolUse", toolCallId: "t1", toolName: "bash", input: {} });
    expect(results).toEqual(["deny"]);
    rmSync(dir, { recursive: true, force: true });
  });
});