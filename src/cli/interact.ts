import { readInstructionFile, buildInitPrompt } from "../context/index.js";
import path from "node:path";
import type { Agent } from "../agent/index.js";
import type { Session, SessionStore } from "../storage/index.js";
import type { HookBus } from "../hooks/index.js";
import type { StreamEvent } from "../core/index.js";
import { modelErrorText } from "../core/index.js";

/**
 * 渲染单个流式事件为文本（CLI 与 root 后台事件共用，DESIGN 15）：
 * 文本/思考直接输出，工具调用与错误加标记。
 */
export function renderStreamEvent(write: (text: string) => void, event: StreamEvent): void {
  switch (event.type) {
    case "text_delta":
      write(event.text);
      break;
    case "thinking_delta":
      write(event.thinking);
      break;
    case "toolcall_start":
      write(`\n[工具] ${event.name ?? "调用"} …`);
      break;
    case "toolcall_end":
      write("\n");
      break;
    case "error":
      write(`\n[错误] ${event.message}`);
      break;
  }
}

export interface InteractOptions {
  agent: Agent;
  store: SessionStore;
  session: Session;
  /** 输入行迭代（CLI 里是 readline 每行一个输入） */
  inputs: AsyncIterable<string>;
  /**
   * 输出函数（CLI 里写 stdout）。承担两类文本：
   * 状态文本（[已压缩]/[未压缩]/[历史已压缩]/[未知命令]）与工具结果回显（[工具结果]，
   * CLI 遗留路径）。TUI 不依赖 write 做结构化渲染——流式事件走 onEvent，工具结果走
   * PostToolUse Hook 事件（此前确认）。
   */
  write: (text: string) => void;
  /** 流式事件渲染回调（此前确认：渲染归属调用方，TUI 结构化消费）；缺省用 renderStreamEvent 文本渲染。
   * 注意与 Team.onRootEvent 配套接入：onEvent 覆盖用户输入驱动的流，onRootEvent 覆盖
   * root 后台驱动（迟到子 agent 结论）的流，两侧都要接才不遗漏。 */
  onEvent?: (event: StreamEvent) => void;
  /** Hook 总线（宿主触发会话级事件的通道，DESIGN 13.3）；缺省不触发 */
  hooks?: HookBus;
  /** 项目根 AGENTS.md 路径（/init 用，测试可注入）；缺省 <cwd>/AGENTS.md */
  projectAgentsFile?: string;
  /**
   * 会话期错误回调（E82，CLI 注入）：run 消费抛错（单次模型链瞬时失败等）时渲染
   * 后继续输入循环，不终止会话进程；文案经 modelErrorText 与装配期「启动失败」区分。
   * 缺省不注入（TUI 宿主）：错误原样上抛，由 TUI 主循环 catch 渲染错误块（现状不变）。
   */
  onError?: (message: string) => void;
}

/**
 * 交互循环：逐行读取输入 → Agent 跑 → 增量渲染（文本/思考/工具调用/错误）→
 * 展示工具结果 → 消息持久化。
 * 会话内命令（统一 / 前缀，DESIGN 15）：/exit 退出、/compact [指导] 强制压缩并重写落盘、
 * /init 生成/改进项目根 AGENTS.md、/help 列出命令；UserPromptSubmit 由宿主（本函数）
 * 在每次输入后触发（DESIGN 13.3）。
 * @param options 交互选项（agent / store / session / inputs / write / hooks）
 */
export async function interact(options: InteractOptions): Promise<void> {
  const { agent, store, session, inputs, write, hooks } = options;
  const projectAgentsFile = options.projectAgentsFile ?? path.join(process.cwd(), "AGENTS.md");
  const render = options.onEvent ?? ((event: StreamEvent): void => renderStreamEvent(write, event));
  // 已落盘游标 = session 内存消息数（appendMessage 会同步 append 到 session 内存；
  // checkpoint 回调在工具执行前已把 user+assistant 入队，轮末只补 tool_result）
  for await (const line of inputs) {
    const input = line.trim();
    if (!input) continue;
    // 本轮真正发给模型的输入：/init 等命令会生成提示词顶替原输入走正常回合
    let turnInput: string | null = null;
    if (input.startsWith("/")) {
      // 会话内命令（统一 / 前缀，DESIGN 15）
      if (input === "/exit") break;
      if (input === "/compact" || input.startsWith("/compact ")) {
        // 强制压缩：替换消息后重写整份落盘（压缩是重写不是追加，session 内存随之整体替换）；
        // 带指导时按指导侧重视现场场摘要（DESIGN 9.8），无指导保留记忆替代省调用路径
        const guidance = input === "/compact" ? undefined : input.slice("/compact ".length).trim() || undefined;
        if (await agent.compactNow(guidance)) {
          // 命令痕迹（E98）：与 TUI 同口径落命令消息，跨宿主续看同一会话命令痕迹一致
          agent.appendCommand(guidance ? `/compact ${guidance}` : "/compact");
          await store.rewriteMessages(session, agent.getMessages());
          agent.consumeHistoryRewritten(); // 消费压缩置位的历史改写标记，防下轮误报重写
          write(guidance ? `\n[已压缩] 已按压缩指导重新摘要会话历史。\n` : "\n[已压缩] 会话历史已压缩，关键上下文已保留。\n");
        } else {
          write("\n[未压缩] 未配置压缩或摘要不可用。\n");
        }
        continue;
      }
      if (input === "/init") {
        // 分析代码库生成/改进项目根 AGENTS.md：生成 init 提示词当作用户输入走正常回合
        // （模型用 write 工具落盘）；已存在时提示词要求不覆盖、先建议改进。
        // 读文件失败（权限等）只报错不终止会话——命令失败不该带崩交互循环，
        // 且必须 continue 跳过本行（E76：字面 "/init" 落到下方会被当用户输入跑完整回合）
        try {
          const existing = await readInstructionFile(projectAgentsFile);
          write(existing ? "\n[init] 已存在 AGENTS.md，将分析并在其基础上建议改进（不覆盖）。\n" : "\n[init] 开始分析代码库，生成项目根 AGENTS.md。\n");
          // 命令痕迹（E98）：与 TUI 同口径落命令消息（随本轮轮末落盘持久化）
          agent.appendCommand(input);
          turnInput = buildInitPrompt(existing);
        } catch (err) {
          write(`\n[init] 读取 AGENTS.md 失败：${err instanceof Error ? err.message : String(err)}\n`);
          continue;
        }
      } else if (input === "/help") {
        write("\n可用命令：/exit 退出；/compact [指导] 压缩会话历史（可附侧重指导）；/init 生成项目 AGENTS.md；/help 帮助\n");
        continue;
      } else {
        write(`\n[未知命令] ${input}（/help 查看可用命令）\n`);
        continue;
      }
    }
    const prompt = turnInput ?? input;
    // 会话级 hook 发射兜底（E82 审查补充）：hook 命令故障不按「启动失败」退出整个会话，
    // 与 turn 内工具级 hook 的兜底语义对齐（CLI 经 onError 渲染后跳过本轮；TUI 上抛）
    try {
      await hooks?.emit({ type: "UserPromptSubmit", input: prompt });
    } catch (err) {
      if (!options.onError) throw err;
      const error = err instanceof Error ? err.message : String(err);
      options.onError(modelErrorText(error));
      continue;
    }
    // 后台续跑活跃（子 agent 完成唤醒 root 正在跑）时等它结束再开新轮——
    // 此时 start 会复位中断信号污染后台轮、run() 因防重入空返回导致落盘游标错位；
    // 后台轮有看门狗/超时兜底必然收尾，用户输入在此排队不丢
    while (agent.isActive()) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 本轮起点：回显工具结果时只回显本轮新增的（重写分支里历史可能被压缩替换）
    const roundStart = agent.getMessages().length;
    agent.start(prompt);
    // 轮末落盘（E48）：放 finally——api error 当轮（模型流抛错）时 agent 内存里已有本轮
    // 用户消息，异常路径跳过落盘会让盘上缺这条，reconfigure/重开后的 UI 与模型上下文不一致；
    // 历史被改写（压缩/裁剪/剥组）按内存整份重写，否则补落盘游标之后的新消息，与正常轮末同一套
    try {
      // 渲染流式事件：文本与思考直接输出，工具调用与错误加标记（渲染归属调用方，此前确认）
      for await (const event of agent.run()) {
        render(event);
      }
    } catch (err) {
      // 会话期错误（E82）：CLI 注入 onError 时渲染后继续输入循环——单次模型链瞬时失败
      // （429/5xx/网络）此前上抛穿到 main catch 按「启动失败」退出整个会话进程，
      // 与 TUI 渲染错误块继续输入循环的行为不对称；未注入（TUI）保持原样上抛。
      // 覆盖面注意（审查补充）：catch 同时兜住 turn 内宿主 checkpoint 回调的落盘故障，
      // 该类错误会被标成会话错误继续循环、随后 finally 落盘大概率再抛穿透——概率极低，
      // 真遇到按两层报错排查即可
      if (!options.onError) throw err;
      const error = err instanceof Error ? err.message : String(err);
      options.onError(modelErrorText(error));
    } finally {
      const agentMessages = agent.getMessages();
      if (agent.consumeHistoryRewritten()) {
        await store.rewriteMessages(session, agentMessages);
        write("\n[历史已压缩] 上下文已压缩，落盘已同步。\n");
      } else {
        const newMessages = agentMessages.slice(session.getMessages().length);
        for (const message of newMessages) {
          await store.appendMessage(session, message);
        }
        // 强制落盘（checkpoint）：本轮消息已入队，flush 后下轮模型请求前历史在盘上
        await store.flush();
      }
    }
    write("\n");
    // 回显本轮工具结果（重写分支也要回显，不能因压缩吞掉工具输出）
    for (const message of agent.getMessages().slice(roundStart)) {
      if (message.role === "tool_result") {
        write(`\n[工具结果] ${message.content}\n`);
      }
    }
  }
}
