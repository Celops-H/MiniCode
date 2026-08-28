import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { McpServerConfig } from "../config/index.js";
import { killProcessTree } from "../tools/index.js";

/** MCP 传输协议版本（initialize 握手声明，BACKEND §19） */
const MCP_PROTOCOL_VERSION = "2024-11-05";
/** 握手超时：initialize 与 tools/list 各自的等待上限 */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** 工具调用超时缺省值（server.timeoutMs 可配） */
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** stderr 尾部保留长度：启动失败时拼进错误信息帮助定位（不无限堆积） */
const MAX_STDERR_TAIL = 2000;
/** stdout 行缓冲上限：不产换行的坏 server 会无限撑大缓冲，超限丢最旧（协议消息必然已坏） */
const MAX_LINE_BUFFER = 1_000_000;

/** server 声明的工具（tools/list 返回项的子集，字段均可能缺省） */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** 工具调用结果：text 段拼接文本 + 失败标记 */
export interface McpCallResult {
  output: string;
  isError: boolean;
}

/** 在途请求条目：timer/abort 监听在所有出路径（响应、超时、中止、进程退出）都要清干净 */
interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * 单个 MCP server 的 stdio 连接（BACKEND §19）：启动子进程、换行分帧 JSON-RPC 2.0 通信。
 * 握手（initialize → notifications/initialized → tools/list）后即可列出工具与调用；
 * 进程退出后拒绝后续调用（不自动重启，重开会话重拉）。
 */
export class McpClient {
  /** 服务名（配置键，用于错误信息与工具命名） */
  readonly name: string;
  private readonly config: McpServerConfig;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private tools: McpToolInfo[] = [];
  private readonly pending = new Map<number, PendingEntry>();
  /** stdout 行缓冲：按 \n 切分出完整 JSON-RPC 消息 */
  private buffer = "";
  /** 流式 UTF-8 解码：管道 chunk 边界可能落在多字节字符中间，直接 toString 会静默产生乱码 */
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  /** stderr 尾部：启动失败时附在错误信息里 */
  private stderrTail = "";
  /** 进程已退出（退出后拒绝全部新请求） */
  private exited = false;
  private exitError = "";

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
  }

  /** server 进程是否仍在运行 */
  get alive(): boolean {
    return !this.exited;
  }

  /** 握手时拿到的工具清单（未启动为空） */
  listTools(): McpToolInfo[] {
    return this.tools;
  }

  /**
   * 启动 server 进程并完成握手，返回声明的工具列表。
   * 启动失败（命令不存在）或握手超时都会抛错，由调用方决定跳过该 server。
   */
  async start(): Promise<McpToolInfo[]> {
    if (this.child) throw new Error(`MCP 服务 ${this.name} 已启动`);
    // Windows 上 npx 等命令实为 .cmd 脚本，需经 shell 解析：命令与 args 自行加引号后拼成完整命令行
    // （args 数组配 shell:true 已被 Node 弃用 DEP0190，故只传命令串）；Unix 直接 spawn，
    // detached 使子进程成为进程组长，killProcessTree 才能按组击杀
    const win32 = process.platform === "win32";
    const command = win32 ? [this.quoteCommand(), ...this.quoteArgs()].join(" ") : this.config.command;
    const args = win32 ? [] : this.config.args ?? [];
    const child = spawn(command, args, {
      shell: win32,
      detached: !win32,
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdin?.on("error", () => {}); // 进程死亡时写 stdin 报 EPIPE，由 exit/error 路径统一拒绝在途请求
    child.stdout?.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.appendStderr(chunk));

    const exitedPrematurely = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        // markExited 内部拒绝全部在途请求：稳态调用期 server 崩溃时，在途 tools/call
        // 立即失败而非挂到超时（错误信息误导且白等满 timeoutMs）
        this.markExited(`进程退出（${code !== null ? `code ${code}` : `信号 ${signal}`}）`);
        reject(new Error(`MCP 服务 ${this.name} 在握手完成前退出${this.stderrSuffix()}`));
      });
      child.once("error", (err) => {
        // spawn 失败（如命令不存在）；exit 事件不一定跟发，这里也标记退出
        this.markExited(`启动失败：${err.message}`);
        reject(new Error(`MCP 服务 ${this.name} 启动失败：${err.message}`));
      });
    });

    const handshake = (async () => {
      await this.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "minicode", version: "0.0.1" },
      }, HANDSHAKE_TIMEOUT_MS);
      this.notify("notifications/initialized");
      const listed = await this.request<{ tools?: McpToolInfo[] }>("tools/list", {}, HANDSHAKE_TIMEOUT_MS);
      this.tools = (listed.tools ?? []).filter((t): t is McpToolInfo => typeof t?.name === "string");
      return this.tools;
    })();

    // 握手成功与「进程先退出」赛跑：谁先到算谁，输的一方被吞掉即可
    return Promise.race([handshake, exitedPrematurely]);
  }

  /**
   * 调用 server 工具（tools/call），返回 text 段拼接的结果。
   * 超时默认 60 秒（server.timeoutMs 可配）；signal 中止时拒绝在途请求，server 进程保留。
   */
  async callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const result = await this.request<{ content?: Array<{ type?: string; text?: string }>; isError?: boolean }>(
      "tools/call",
      { name: toolName, arguments: args },
      timeoutMs,
      signal,
    );
    const text = (result.content ?? [])
      .filter((seg) => seg?.type === "text" && typeof seg.text === "string")
      .map((seg) => seg.text)
      .join("\n");
    return { output: text, isError: result.isError === true };
  }

  /**
   * 停止 server：按进程树强杀（防 shell 包装层或孙进程残留），在途请求随 markExited 拒绝。
   * 已退出的进程不再杀树：pid 可能已被 OS 复用，taskkill 会误杀无关进程。
   */
  stop(): void {
    if (!this.exited && this.child && this.child.pid !== undefined) killProcessTree(this.child.pid);
    this.child = null;
    if (!this.exited) this.markExited("已停止");
  }

  /**
   * Windows 经 shell 启动时 Node 不给命令与参数加引号，含空格/引号的命令与参数在此处理。
   * 注意 shell 拼接不设防 cmd 元字符（& | ^ %VAR%）：配置由用户自管，含元字符的参数行为未定义。
   */
  private quoteCommand(): string {
    const command = this.config.command;
    if (process.platform !== "win32") return command;
    return /\s/.test(command) ? `"${command}"` : command;
  }

  private quoteArgs(): string[] {
    const args = this.config.args ?? [];
    if (process.platform !== "win32") return args;
    return args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg));
  }

  /**
   * 标记进程退出：后续新请求直接拒绝（不自动重启，重开会话重拉）；
   * 在途请求同时拒绝（server 已死不可能再回包，挂到超时只会白等且错误误导）。
   */
  private markExited(reason: string): void {
    this.exited = true;
    this.exitError = reason;
    this.rejectAllPending(new Error(`MCP 服务 ${this.name} ${reason}，在途请求已终止`));
  }

  /** 发送请求并等待对应 id 的响应；超时/中止/进程退出都会拒绝 */
  private request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.exited || !this.child) {
      return Promise.reject(new Error(`MCP 服务 ${this.name} ${this.exitError || "已退出"}，无法处理 ${method}`));
    }
    const id = this.nextId++;
    const child = this.child;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingEntry = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => {
          this.dropPending(id, entry);
          reject(new Error(`MCP 服务 ${this.name} 请求超时（${method}，${timeoutMs}ms）`));
        }, timeoutMs),
      };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(entry.timer);
          reject(new Error(`MCP 请求已中止（${method}）`));
          return;
        }
        entry.signal = signal;
        entry.onAbort = () => {
          this.dropPending(id, entry);
          reject(new Error(`MCP 请求已中止（${method}）`));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (err) => {
        if (err) {
          this.dropPending(id, entry);
          reject(new Error(`MCP 服务 ${this.name} 写入失败：${err.message}`));
        }
      });
    });
  }

  /** 发送通知（无 id、无响应） */
  private notify(method: string): void {
    this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n", () => {});
  }

  /** 从 pending 摘除条目并清 timer/abort 监听（重复调用无害：Map.delete 幂等） */
  private dropPending(id: number, entry: PendingEntry): void {
    clearTimeout(entry.timer);
    if (entry.onAbort && entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
    this.pending.delete(id);
  }

  /** 收 stdout：行缓冲切分、逐行解析分发（解析失败的行丢弃——不把半截日志当协议消息） */
  private handleStdout(chunk: Buffer): void {
    this.buffer += this.stdoutDecoder.write(chunk);
    if (this.buffer.length > MAX_LINE_BUFFER) this.buffer = this.buffer.slice(-MAX_LINE_BUFFER);
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: unknown; result?: unknown; error?: { message?: string } | null };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id !== "number") continue; // server 通知（如 tools/list_changed）：本版不处理
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.dropPending(msg.id, entry);
      if (msg.error) {
        entry.reject(new Error(`MCP 服务 ${this.name} 返回错误：${msg.error.message ?? "未知错误"}`));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  private appendStderr(chunk: Buffer): void {
    this.stderrTail = (this.stderrTail + this.stderrDecoder.write(chunk)).slice(-MAX_STDERR_TAIL);
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail.trim();
    return tail ? `：\nstderr：${tail}` : "";
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of [...this.pending]) {
      this.dropPending(id, entry);
      entry.reject(err);
    }
  }
}
