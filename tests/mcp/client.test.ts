import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { McpClient } from "../../src/mcp/client.js";
import type { McpServerConfig } from "../../src/config/index.js";

/**
 * 假 MCP server（.cjs）：换行分帧 JSON-RPC，覆盖 initialize / tools/list / tools/call。
 * FAKE_MODE 控制行为分支：silent（tools/call 永不回复）、crash-after-list（tools/list 后自杀）。
 */
const FAKE_SERVER = `const rl = require("node:readline").createInterface({ input: process.stdin });
const tools = [
  { name: "echo", description: "回声工具", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "boom", description: "必失败工具" },
];
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (typeof msg.id !== "number") return;
  if (msg.method === "initialize") reply(msg.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "0.0.0" } });
  else if (msg.method === "tools/list") {
    reply(msg.id, { tools });
    if (process.env.FAKE_MODE === "crash-after-list") setTimeout(() => process.exit(0), 50);
  } else if (msg.method === "tools/call") {
    if (process.env.FAKE_MODE === "silent") return;
    const text = msg.params?.arguments?.text;
    if (msg.params?.name === "boom") reply(msg.id, { content: [{ type: "text", text: "工具内部失败" }], isError: true });
    else reply(msg.id, { content: [{ type: "text", text: "echo: " + text }, { type: "text", text: "第二段" }] });
  }
});`;

let tmpDir: string;
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
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-mcp-"));
    serverFile = path.join(tmpDir, "fake-server.cjs");
    writeFileSync(serverFile, FAKE_SERVER);
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
