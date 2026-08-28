import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 假 MCP server（.cjs）：换行分帧 JSON-RPC，覆盖 initialize / tools/list / tools/call。
 * FAKE_MODE 控制行为分支：silent（tools/call 永不回复）、crash-after-list（tools/list 后自杀）、
 * crash-on-call（收到 tools/call 立即退出不回复，用于在途请求跨进程退出的断言）、
 * flood（tools/call 先灌 2MB 无结构输出再正常回复，用于行缓冲超限后解析不失效的断言）、
 * bigtext（回复 7 万个多字节汉字，用于跨 chunk 边界解码断言）。
 * FAKE_TOOLS（JSON 数组）覆盖声明的工具清单。
 */
export const FAKE_SERVER = `const rl = require("node:readline").createInterface({ input: process.stdin });
const tools = process.env.FAKE_TOOLS ? JSON.parse(process.env.FAKE_TOOLS) : [
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
    if (process.env.FAKE_MODE === "crash-on-call") process.exit(0);
    if (process.env.FAKE_MODE === "bigtext") { reply(msg.id, { content: [{ type: "text", text: "汉".repeat(70000) }] }); return; }
    if (process.env.FAKE_MODE === "flood") { process.stdout.write("x".repeat(2 * 1024 * 1024) + "\\n"); reply(msg.id, { content: [{ type: "text", text: "洪水后正常" }] }); return; }
    const text = msg.params?.arguments?.text;
    if (msg.params?.name === "boom") reply(msg.id, { content: [{ type: "text", text: "工具内部失败" }], isError: true });
    else reply(msg.id, { content: [{ type: "text", text: "echo: " + text }, { type: "text", text: "第二段" }] });
  }
});`;

/** 在临时目录落盘假 server 脚本，返回脚本绝对路径 */
export function writeFakeServer(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "minicode-mcp-"));
  const file = path.join(dir, "fake-server.cjs");
  writeFileSync(file, FAKE_SERVER);
  return file;
}
