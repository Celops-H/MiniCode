import { z } from "zod";
import type { McpServerConfig } from "../config/index.js";
import type { Tool } from "../tools/index.js";
import { McpClient } from "./client.js";

/** 接入的 MCP 工具结果字符上限（BACKEND §19） */
const MCP_MAX_RESULT_CHARS = 30_000;

/** 单个 server 的装配状态（TUI /mcp 面板与装配错误行共用） */
export interface McpServerStatus {
  name: string;
  /** 配置 enabled（缺省 true）；关闭的 server 不启动 */
  enabled: boolean;
  /** 进程已启动并完成握手且仍在运行 */
  started: boolean;
  /** 曾启动过但进程已退出（非主动停止）：面板显示「进程已退出」而非「未启动」 */
  exited?: boolean;
  /** 接入的工具数（未启动为 0） */
  toolCount: number;
  /** 启动失败原因（仅失败 server 有） */
  error?: string;
}

/** 活跃 manager 注册表：进程退出兜底用（崩溃路径 finally 不执行，靠 exit 钩子杀全部 server 防孤儿） */
const activeManagers = new Set<McpManager>();

/** 进程退出兜底：强杀全部仍在运行的 MCP server（宿主 process.on("exit") 调用） */
export function killAllMcpServers(): void {
  for (const manager of [...activeManagers]) manager.stopAll();
}

/**
 * MCP server 生命周期管理（BACKEND §19）：装配时启动全部已启用 server 并完成握手，
 * 失败的跳过并记录错误行（不阻断会话）；会话结束 stopAll 按进程树杀防孤儿。
 */
export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly failure = new Map<string, string>();
  private readonly toolCount = new Map<string, number>();
  /** 工具重名丢弃告警行（mcp__ 前缀拼接可能撞名） */
  private readonly collisions: string[] = [];
  private readonly configs: Record<string, McpServerConfig>;

  constructor(servers: Record<string, McpServerConfig>) {
    this.configs = servers;
  }

  /**
   * 并发启动全部 enabled server 并握手，返回接入的工具（mcp__服务名__工具名）。
   * 启动失败的 server 跳过（错误留在 errors()），其余正常接入。
   */
  async startAll(): Promise<Tool[]> {
    const names = Object.entries(this.configs).filter(([, cfg]) => cfg.enabled !== false);
    await Promise.all(names.map(([name, cfg]) => this.startOne(name, cfg)));
    if (this.clients.size > 0) activeManagers.add(this);
    // 按配置键序收工具（并发启动完成序不定，重名「保留先到」需确定序）；
    // mcp__服务__工具 拼接可能撞名（服务 a+工具 b__c ≡ 服务 a__b+工具 c），同名覆盖会让
    // 工具无声消失，丢弃后者并记错误行
    const seen = new Map<string, string>();
    const result: Tool[] = [];
    for (const [name] of Object.entries(this.configs)) {
      const client = this.clients.get(name);
      if (!client) continue;
      for (const tool of this.toolsOf(client)) {
        const prev = seen.get(tool.name);
        if (prev !== undefined) {
          this.collisions.push(`MCP 工具重名：${tool.name}（服务 ${name} 与 ${prev} 撞名，保留 ${prev} 的）`);
          continue;
        }
        seen.set(tool.name, name);
        result.push(tool);
      }
    }
    return result;
  }

  /** 全部 server 的装配状态（含 enabled=false 与失败项，供面板展示） */
  statuses(): McpServerStatus[] {
    return Object.entries(this.configs).map(([name, cfg]) => {
      const enabled = cfg.enabled !== false;
      const client = this.clients.get(name);
      return {
        name,
        enabled,
        started: enabled && !!client?.alive,
        // 曾启动过但进程已退出（非 stopAll 主动停）：与「从未启动」区分，面板显示不误导
        exited: enabled && !!client && !client.alive,
        toolCount: this.toolCount.get(name) ?? 0,
        error: this.failure.get(name),
      };
    });
  }

  /** 启动失败与工具重名错误行（宿主装配后输出给用户） */
  errors(): string[] {
    return [
      ...[...this.failure.entries()].map(([name, err]) => `MCP 服务 ${name} 启动失败：${err}`),
      ...this.collisions,
    ];
  }

  /** 会话结束统一停止：按进程树杀全部 server，防孤儿进程；并从退出兜底注册表移除 */
  stopAll(): void {
    activeManagers.delete(this);
    for (const client of this.clients.values()) client.stop();
  }

  private async startOne(name: string, cfg: McpServerConfig): Promise<void> {
    const client = new McpClient(name, cfg);
    try {
      const tools = await client.start();
      this.clients.set(name, client);
      this.toolCount.set(name, tools.length);
    } catch (err) {
      // 启动失败：握手超时时进程可能还挂着，必须补杀防孤儿
      client.stop();
      this.failure.set(name, (err as Error).message);
    }
  }

  /** 把一个 server 的工具列表包装成内置 Tool 同构对象（走统一权限管线与执行调度） */
  private toolsOf(client: McpClient): Tool[] {
    // 工具清单在握手时已拿到并包成 Tool；server 侧 tools/list_changed 通知本版不处理，
    // 工具集以装配时为准（重开会话重拉）
    return client.listTools().map((info) => ({
      name: `mcp__${client.name}__${info.name}`,
      description: info.description ?? `MCP 服务 ${client.name} 的 ${info.name} 工具`,
      inputSchema: z.unknown(),
      inputJsonSchema: info.inputSchema,
      isReadOnly: false, // 外部副作用不可判：走完整审批链（BACKEND §19）
      requiresUserInteraction: false,
      maxResultSizeChars: MCP_MAX_RESULT_CHARS,
      async execute(input, options) {
        const args = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
        const result = await client.callTool(info.name, args, options?.signal);
        return { output: result.output || "（MCP 工具无文本输出）", isError: result.isError };
      },
    }));
  }
}
