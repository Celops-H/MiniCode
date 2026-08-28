import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../src/tools/index.js";
import { McpManager, killAllMcpServers } from "../../src/mcp/manager.js";
import { writeFakeServer } from "./helpers.js";

let serverFile: string;

/** 造一个指向假 server 的服务配置（env 透传 FAKE_MODE） */
function fakeConfig(mode?: string) {
  return {
    command: process.execPath,
    args: [serverFile],
    ...(mode ? { env: { FAKE_MODE: mode } } : {}),
  };
}

describe("McpManager（生命周期与工具接入）", () => {
  const managers: McpManager[] = [];

  beforeAll(() => {
    serverFile = writeFakeServer();
  });

  afterEach(() => {
    for (const m of managers.splice(0)) m.stopAll();
  });

  it("启动全部 server 并接入 mcp__服务__工具 命名的工具", async () => {
    const manager = new McpManager({ fs: fakeConfig(), git: fakeConfig() });
    managers.push(manager);
    const tools = await manager.startAll();
    // 两个 server 各声明 2 个工具
    expect(tools.map((t) => t.name).sort()).toEqual([
      "mcp__fs__boom",
      "mcp__fs__echo",
      "mcp__git__boom",
      "mcp__git__echo",
    ]);
    expect(manager.errors()).toEqual([]);
  });

  it("接入的工具与内置 Tool 同构：JSON Schema 透传、isReadOnly=false 走审批链", async () => {
    const manager = new McpManager({ fs: fakeConfig() });
    managers.push(manager);
    const [tool] = await manager.startAll();
    expect(tool?.isReadOnly).toBe(false);
    expect(tool?.isConcurrencySafe).toBeUndefined();
    const registry = new ToolRegistry();
    registry.register(tool!);
    const def = registry.definitions()[0];
    // server 提供的 JSON Schema 原样透传，不经 zod 转换
    expect(def?.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
    });
  });

  it("工具 execute 经 client 调用，返回 text 拼接与失败标记", async () => {
    const manager = new McpManager({ fs: fakeConfig() });
    managers.push(manager);
    const tools = await manager.startAll();
    const echo = tools.find((t) => t.name === "mcp__fs__echo")!;
    const ok = await echo.execute({ text: "hi" });
    expect(ok).toMatchObject({ output: "echo: hi\n第二段", isError: false });
    const boom = tools.find((t) => t.name === "mcp__fs__boom")!;
    const bad = await boom.execute({});
    expect(bad).toMatchObject({ output: "工具内部失败", isError: true });
  });

  it("enabled=false 的 server 跳过不启动，状态标注未启动", async () => {
    const manager = new McpManager({
      off: { ...fakeConfig(), enabled: false },
      on: fakeConfig(),
    });
    managers.push(manager);
    const tools = await manager.startAll();
    // 只有启用的 server 接入工具
    expect(tools.every((t) => t.name.startsWith("mcp__on__"))).toBe(true);
    const [off, on] = manager.statuses();
    expect(off).toMatchObject({ name: "off", enabled: false, started: false, toolCount: 0 });
    expect(on).toMatchObject({ name: "on", enabled: true, started: true, toolCount: 2 });
    expect(manager.errors()).toEqual([]);
  });

  it("启动失败的 server 跳过并记录错误，不阻断其余 server 接入", async () => {
    const manager = new McpManager({
      bad: { command: "minicode-definitely-not-a-command-xyz" },
      good: fakeConfig(),
    });
    managers.push(manager);
    const tools = await manager.startAll();
    expect(tools.every((t) => t.name.startsWith("mcp__good__"))).toBe(true);
    const errors = manager.errors();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^MCP 服务 bad 启动失败：/);
    const bad = manager.statuses().find((s) => s.name === "bad");
    expect(bad).toMatchObject({ name: "bad", enabled: true, started: false });
    expect(bad?.error).toBeTruthy();
  });

  it("stopAll 停止全部 server", async () => {
    const manager = new McpManager({ a: fakeConfig(), b: fakeConfig() });
    managers.push(manager);
    await manager.startAll();
    manager.stopAll();
    for (const status of manager.statuses()) {
      expect(status.started).toBe(false);
    }
  });

  it("killAllMcpServers 进程退出兜底：不经会话 finally 也能杀掉活跃 server", async () => {
    const manager = new McpManager({ a: fakeConfig() });
    await manager.startAll();
    expect(manager.statuses()[0]?.started).toBe(true);
    // 模拟崩溃路径：不走 stopAll，直接兜底
    killAllMcpServers();
    expect(manager.statuses()[0]?.started).toBe(false);
    // 兜底后 manager 从注册表移除：再次兜底/stopAll 幂等无害
    killAllMcpServers();
    manager.stopAll();
  });

  it("server 中途崩溃的状态标 exited（区别于从未启动）", async () => {
    const manager = new McpManager({ crash: fakeConfig("crash-after-list") });
    managers.push(manager);
    await manager.startAll();
    await new Promise((r) => setTimeout(r, 150));
    const status = manager.statuses()[0];
    expect(status).toMatchObject({ name: "crash", started: false, exited: true });
  });

  it("mcp__ 拼接撞名的工具丢弃后者并记错误行（不无声覆盖）", async () => {
    // 服务 a 声明工具 b__c、服务 a__b 声明工具 c：都拼成 mcp__a__b__c
    const manager = new McpManager({
      a: { ...fakeConfig(), env: { FAKE_TOOLS: JSON.stringify([{ name: "b__c" }]) } },
      "a__b": { ...fakeConfig(), env: { FAKE_TOOLS: JSON.stringify([{ name: "c" }]) } },
    });
    managers.push(manager);
    const tools = await manager.startAll();
    expect(tools.map((t) => t.name)).toEqual(["mcp__a__b__c"]);
    expect(manager.errors()).toEqual([
      expect.stringMatching(/^MCP 工具重名：mcp__a__b__c（服务 a__b 与 a 撞名，保留 a 的）$/),
    ]);
  });

  it("z.unknown() 校验放行任意入参（入参正确性交给 server 自校验）", async () => {
    const manager = new McpManager({ fs: fakeConfig() });
    managers.push(manager);
    const [tool] = await manager.startAll();
    expect(tool?.inputSchema.safeParse({ whatever: [1, 2, 3] }).success).toBe(true);
  });
});
