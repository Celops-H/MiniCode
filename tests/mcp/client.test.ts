import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { McpClient } from "../../src/mcp/client.js";
import type { McpServerConfig } from "../../src/config/index.js";
import { writeFakeServer } from "./helpers.js";

let serverFile: string;

/** 造一个指向假 server 的 client（env 透传 FAKE_MODE） */
function makeClient(mode?: string, overrides: Partial<McpServerConfig> = {}): McpClient {
  const config: McpServerConfig = {
    command: process.execPath,
    args: [serverFile],
    ...(mode ? { env: { FAKE_MODE: mode } } : {}),
    ...overrides,
  };
  return new McpClient("fake", config);
}

describe("McpClient（stdio JSON-RPC）", () => {
  const clients: McpClient[] = [];

  beforeAll(() => {
    serverFile = writeFakeServer();
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.stop();
  });

  it("握手成功并列出声明的工具", async () => {
    const client = makeClient();
    clients.push(client);
    const tools = await client.start();
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: "echo", description: "回声工具" });
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });
  });

  it("callTool 返回 text 段拼接文本", async () => {
    const client = makeClient();
    clients.push(client);
    await client.start();
    const result = await client.callTool("echo", { text: "你好" });
    expect(result.output).toBe("echo: 你好\n第二段");
    expect(result.isError).toBe(false);
  });

  it("callTool 透传 server 的 isError 失败标记", async () => {
    const client = makeClient();
    clients.push(client);
    await client.start();
    const result = await client.callTool("boom", {});
    expect(result.output).toBe("工具内部失败");
    expect(result.isError).toBe(true);
  });

  it("call 超时（timeoutMs 可配）后拒绝且不再等回复", async () => {
    const client = makeClient("silent", { timeoutMs: 300 });
    clients.push(client);
    await client.start();
    await expect(client.callTool("echo", {})).rejects.toThrow(/请求超时（tools\/call，300ms）/);
    expect(client.alive).toBe(true); // 超时不杀 server 进程
  });

  it("AbortSignal 中止在途请求，server 进程保留", async () => {
    const client = makeClient("silent");
    clients.push(client);
    await client.start();
    const controller = new AbortController();
    const pending = client.callTool("echo", {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("MCP 请求已中止（tools/call）");
    expect(client.alive).toBe(true);
  });

  it("server 进程退出后拒绝后续调用（不自动重启）", async () => {
    const client = makeClient("crash-after-list");
    clients.push(client);
    await client.start();
    await new Promise((r) => setTimeout(r, 150)); // 等 crash-after-list 自杀
    await expect(client.callTool("echo", {})).rejects.toThrow(/进程退出.*无法处理 tools\/call/);
  });

  it("命令不存在时 start 报启动失败", async () => {
    const client = new McpClient("bad", { command: "minicode-definitely-not-a-command-xyz" });
    await expect(client.start()).rejects.toThrow(/启动失败|握手完成前退出/);
  });

  it("stop 按树杀进程并拒绝在途请求", async () => {
    const client = makeClient();
    await client.start();
    const pending = client.callTool("echo", {});
    client.stop();
    await expect(pending).rejects.toThrow("MCP 服务 fake 已停止");
    expect(client.alive).toBe(false);
  });
});
