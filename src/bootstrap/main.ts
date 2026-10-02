/**
 * 入口与 program 装配：commander 命令定义、顶层 TUI 形态接管、进程级初始化与退出清理。
 * 会话装配函数在 ./assemble.js，模型解析在 ./models.js，会话驱动循环在 ./interact.js，
 * dist 过期检测在 ./staleBuild.js。交互界面只有 TUI 一种（无参/-c 顶层形态与 tui 子命令都进 TUI）。
 */
import { Command } from "commander";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureGlobalConfigSeed, loadConfig, loadEnvFile, resolveSessionsDir } from "../config/index.js";
import { killAllMcpServers } from "../mcp/index.js";
import { SessionStore } from "../storage/index.js";
import { killAllBackgroundTasks } from "../tools/index.js";
import { rebuildIfStale } from "./staleBuild.js";
import { MINICODE_VERSION } from "./assemble.js";

export const program = new Command();
program
  .name("minicode")
  .description("AI 编程 Agent 命令行工具（无参数直接进 TUI；minicode -c 继续最近会话）")
  .version(MINICODE_VERSION);

program
  .command("list")
  .description("列出会话")
  .action(async () => {
    const config = await loadConfig();
    const store = new SessionStore(resolveSessionsDir({ cwd: process.cwd(), root: config.sessionsDir }));
    const sessions = await store.listSessions();
    if (sessions.length === 0) {
      console.log("暂无会话");
      return;
    }
    for (const meta of sessions) {
      console.log(`${meta.id}  ${meta.title}  ${meta.model}  ${meta.updatedAt}`);
    }
  });

// TUI 会话界面（前端接线，入口装配在 src/tui/index.tsx）
program
  .command("tui")
  .description("进入 TUI 会话界面")
  .option("-c, --continue [sessionId]", "继续会话（无参数取最近活跃）")
  .option("--no-agents", "禁用多 Agent 协作（单 agent 会话）")
  .action(async (options: { continue?: string | boolean; agents?: boolean }) => {
    const { runTuiEntry } = await import("../tui/index.js");
    await runTuiEntry({
      sessionId: typeof options.continue === "string" ? options.continue : undefined,
      continueRecent: options.continue === true,
      agents: options.agents,
    });
  });

/**
 * 识别无子命令的顶层 TUI 形态：minicode（无参）进 TUI 空态、minicode -c [id] 继续最近/指定、
 * minicode --no-agents 禁多 Agent。其余形态返回 null（交 commander 正常分派子命令）。
 * 解析**位置无关**（--no-agents 在 -c 前后等价）；-c/--continue 后跟非 flag 参数即会话
 * id，--continue=id 内联；空值（-c 后无值 / --continue= 空串）统一按「继续最近」。
 * 不用 commander 默认 action：commander 15 默认 action 与子命令混用实测不可靠（minicode tui 会被默认
 * action 截走、顶层可选 option 的 -c <id> 报 too many arguments），故 main 在 parseAsync 前手动接管。
 */
export function topLevelTui(argv: string[]): { sessionId?: string; continueRecent?: boolean; agents?: boolean } | null {
  if (argv.length === 0) return { agents: true };
  let sessionId: string | undefined;
  let continueFlag = false;
  let agents: boolean | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "") continue; // 空参数（-c "" 的空值已由 next 判定消费）无意义，忽略
    if (a === "-c" || a === "--continue") {
      continueFlag = true;
      const next = argv[i + 1];
      // 空串视为无值（统一空值语义：按继续最近，不产生空会话 id）
      if (next && !next.startsWith("-")) {
        sessionId = next;
        i++;
      }
    } else if (a.startsWith("--continue=")) {
      continueFlag = true;
      const inline = a.slice("--continue=".length);
      if (inline) sessionId = inline;
    } else if (a === "--no-agents") {
      agents = false;
    } else {
      // 非顶层形态参数（子命令名如 tui/list、未知 flag）→ 交 commander
      return null;
    }
  }
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(continueFlag && !sessionId ? { continueRecent: true } : {}),
    agents: agents ?? true,
  };
}

/** 顶层 TUI 形态接管：识别成功则进 TUI 并返回 true，否则返回 false（main 交 commander） */
async function tryTopLevelTui(argv: string[]): Promise<boolean> {
  const entry = topLevelTui(argv);
  if (!entry) return false;
  try {
    const { runTuiEntry } = await import("../tui/index.js");
    await runTuiEntry(entry);
  } catch (err) {
    // minicode -c <不存在的会话 id>：loadSession 抛 ENOENT，给可读提示而非原始文件路径
    if ((err as { code?: string }).code === "ENOENT" && entry.sessionId) {
      console.error(`会话不存在：${entry.sessionId}`);
      return true;
    }
    throw err;
  }
  return true;
}

export async function main(): Promise<void> {
  // 进程退出统一清理后台任务与 MCP server，防孤儿进程残留：
  // 崩溃路径（uncaughtException 等先于 process.exit）会话 finally 不执行，exit 钩子是最后防线
  process.on("exit", () => {
    killAllBackgroundTasks();
    killAllMcpServers();
  });
  // dist 过期自动重建：产物早于最近提交时先 pnpm build 再进界面，防拿过期产物；
  // 源码直跑（tsx dev）与非 git 环境静默跳过
  await rebuildIfStale();
  // 全局配置播种：任一入口装配配置前检测，config.json 缺失才按预设写种子
  await ensureGlobalConfigSeed();
  await loadDotEnv();
  // 顶层 TUI 快捷入口在 commander 前手动接管（见 topLevelTui）；其余交 commander 分派子命令
  if (await tryTopLevelTui(process.argv.slice(2))) return;
  await program.parseAsync(process.argv);
}

/** 启动时从 cwd/.env 加载环境变量注入 process.env（已有变量不覆盖，见 parseEnvFile），API key 免手动 export */
async function loadDotEnv(): Promise<void> {
  const vars = await loadEnvFile(path.join(process.cwd(), ".env"));
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`启动失败：${(err as Error).message}`);
    process.exit(1);
  });
}
