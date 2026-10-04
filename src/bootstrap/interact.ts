import { readInstructionFile, buildInitPrompt } from "../context/index.js";
import path from "node:path";
import type { Agent } from "../agent/index.js";
import { DEFAULT_SESSION_TITLE, sessionTitleFromInput, type Session, type SessionStore } from "../storage/index.js";
import type { HookBus } from "../hooks/index.js";
import type { StreamEvent } from "../core/index.js";
import { modelErrorText } from "../core/index.js";

export interface InteractOptions {
  agent: Agent;
  store: SessionStore;
  session: Session;
  /** 输入行迭代（每行一次输入；测试注入异步生成器） */
  inputs: AsyncIterable<string>;
  /**
   * 输出函数。承担两类文本：状态文本（[已压缩]/[未压缩]/[历史已压缩]/[未知命令]）
   * 与工具结果回显（[工具结果]，文本宿主遗留路径）。TUI 不依赖 write 做结构化渲染——
   * 流式事件走 onEvent，工具结果走 PostToolUse Hook 事件。
   */
  write: (text: string) => void;
  /** 流式事件渲染回调（必填：渲染归属调用方，TUI 结构化消费、测试注入收集回调）。
   * 回调抛错在宿主循环内就地吞掉（每轮首个失败经 write 报一次），不中断本轮事件消费；
   * 注意与 Team.onRootEvent 配套接入：onEvent 覆盖用户输入驱动的流，onRootEvent 覆盖
   * root 后台驱动（迟到子 agent 结论）的流，两侧都要接才不遗漏。 */
  onEvent: (event: StreamEvent) => void;
  /** Hook 总线（宿主触发会话级事件的通道）；缺省不触发 */
  hooks?: HookBus;
  /** 项目根 AGENTS.md 路径（/init 用，测试可注入）；缺省 <cwd>/AGENTS.md */
  projectAgentsFile?: string;
  /**
   * 会话期错误回调：run 消费抛错（单次模型链瞬时失败等）时渲染
   * 后继续输入循环，不终止会话进程；文案经 modelErrorText 与装配期「启动失败」区分。
   * 缺省不注入（TUI 宿主）：错误原样上抛，由 TUI 主循环 catch 渲染错误块（现状不变）。
   */
  onError?: (message: string) => void;
  /**
   * 首轮结束自动起名回调：标题派生自用户输入（截断），宿主同步界面标题显示
   * （TUI 状态行）。缺省不注入（无界面的测试宿主无需同步）。
   */
  onTitleAutoNamed?: (title: string) => void;
}

/**
 * 交互循环：逐行读取输入 → Agent 跑 → 增量渲染（文本/思考/工具调用/错误）→
 * 展示工具结果 → 消息持久化。
 * 会话内命令（统一 / 前缀）：/exit 退出、/compact [指导] 强制压缩并重写落盘、
 * /init 生成/改进项目根 AGENTS.md、/help 列出命令；UserPromptSubmit 由宿主（本函数）
 * 在每次输入后触发。
 * @param options 交互选项（agent / store / session / inputs / write / hooks）
 */
export async function interact(options: InteractOptions): Promise<void> {
  const { agent, store, session, inputs, write, hooks } = options;
  const projectAgentsFile = options.projectAgentsFile ?? path.join(process.cwd(), "AGENTS.md");
  const render = options.onEvent;
  // 已落盘游标 = session 内存消息数（appendMessage 会同步 append 到 session 内存；
  // checkpoint 回调在工具执行前已把 user+assistant 入队，轮末只补 tool_result）
  for await (const line of inputs) {
    const input = line.trim();
    if (!input) continue;
    // 本轮真正发给模型的输入：/init 等命令会生成提示词顶替原输入走正常回合
    let turnInput: string | null = null;
    if (input.startsWith("/")) {
      // 会话内命令（统一 / 前缀）
      if (input === "/exit") break;
      if (input === "/compact" || input.startsWith("/compact ")) {
        // 强制压缩：替换消息后重写整份落盘（压缩是重写不是追加，session 内存随之整体替换）；
        // 带指导时按指导侧重视现场场摘要，无指导保留记忆替代省调用路径
        const guidance = input === "/compact" ? undefined : input.slice("/compact ".length).trim() || undefined;
        if (await agent.compactNow(guidance)) {
          // 命令痕迹：与 TUI 同口径落命令消息，跨宿主续看同一会话命令痕迹一致
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
        // 且必须 continue 跳过本行（字面 "/init" 落到下方会被当用户输入跑完整回合）
        try {
          const existing = await readInstructionFile(projectAgentsFile);
          write(existing ? "\n[init] 已存在 AGENTS.md，将分析并在其基础上建议改进（不覆盖）。\n" : "\n[init] 开始分析代码库，生成项目根 AGENTS.md。\n");
          // 命令痕迹：与 TUI 同口径落命令消息（随本轮轮末落盘持久化）
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
    // 会话级 hook 发射兜底：hook 命令故障不按「启动失败」退出整个会话，
    // 与 turn 内工具级 hook 的兜底语义对齐（注入 onError 时渲染后跳过本轮；缺省上抛）
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
    // 轮末落盘：放 finally——api error 当轮（模型流抛错）时 agent 内存里已有本轮
    // 用户消息，异常路径跳过落盘会让盘上缺这条，reconfigure/重开后的 UI 与模型上下文不一致；
    // 历史被改写（压缩/裁剪/剥组）按内存整份重写，否则补落盘游标之后的新消息，与正常轮末同一套
    try {
      // 渲染流式事件：文本与思考直接输出，工具调用与错误加标记（渲染归属调用方）
      // 渲染异常边界：渲染是宿主的事（界面/store 更新），抛出只应算界面上的一次失败，
      // 不能中断本轮事件消费——一旦从消费循环里抛出，agent 的事件流被提前收尾，
      // assistant 消息不落盘、轮末 Stop 不发，宿主界面停在「运行中」且再也回不来。
      // 首个失败经 write 报一次（宿主可自行呈现），后续静默，避免每个事件都刷一条
      let renderFailureReported = false;
      for await (const event of agent.run()) {
        try {
          render(event);
        } catch (err) {
          if (!renderFailureReported) {
            renderFailureReported = true;
            // 上报通道自身也可能抛（TUI 的 write 经 store 更新渲染，与刚失败的渲染同类），
            // 再兜一层，否则等于把刚挡下的中断从 catch 里放回事件流
            try {
              write(`\n[渲染失败] ${err instanceof Error ? err.message : String(err)}（本轮回复照常落盘）\n`);
            } catch {
              // 失败提示丢了不致命，本轮照常跑完
            }
          }
        }
      }
    } catch (err) {
      // 会话期错误：注入 onError 时渲染后继续输入循环——单次模型链瞬时失败
      // （429/5xx/网络）渲染后可继续对话而非终止进程，与 TUI 渲染错误块继续输入循环同向；
      // 未注入（TUI 宿主）保持原样上抛。
      // 覆盖面注意：catch 同时兜住 turn 内宿主 checkpoint 回调的落盘故障，
      // 该类错误会被标成会话错误继续循环、随后 finally 落盘大概率再抛穿透——概率极低，
      // 真遇到按两层报错排查即可
      if (!options.onError) throw err;
      const error = err instanceof Error ? err.message : String(err);
      options.onError(modelErrorText(error));
    } finally {
      // 首轮结束自动起名：标题仍是默认值（用户 /rename 改过则不等于默认值，不覆盖）
      // 且本轮是真实用户输入（/init /compact 等命令轮不起名，留给下一条真实消息）时，
      // 取输入派生标题并回调宿主同步界面；下面的落盘把新标题随 meta 一并写盘。
      // 已知边界：改名恰好改成默认值、或输入恰好是「新会话」时按同一判定处理，
      // 不为区分再加持久化改名标记
      if (session.meta.title === DEFAULT_SESSION_TITLE && !input.startsWith("/")) {
        session.meta.title = sessionTitleFromInput(prompt);
        options.onTitleAutoNamed?.(session.meta.title);
      }
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
