import type { Agent } from "../agent/index.js";
import type { Session, SessionStore } from "../storage/index.js";
import type { HookBus } from "../hooks/index.js";
import type { StreamEvent } from "../core/index.js";

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
}

/**
 * 交互循环：逐行读取输入 → Agent 跑 → 增量渲染（文本/思考/工具调用/错误）→
 * 展示工具结果 → 消息持久化。
 * 会话内命令（统一 / 前缀，DESIGN 15）：/exit 退出、/compact 强制压缩并重写落盘、
 * /help 列出命令；UserPromptSubmit 由宿主（本函数）在每次输入后触发（DESIGN 13.3）。
 * @param options 交互选项（agent / store / session / inputs / write / hooks）
 */
export async function interact(options: InteractOptions): Promise<void> {
  const { agent, store, session, inputs, write, hooks } = options;
  const render = options.onEvent ?? ((event: StreamEvent): void => renderStreamEvent(write, event));
  // 已落盘游标 = session 内存消息数（appendMessage 会同步 append 到 session 内存；
  // checkpoint 回调在工具执行前已把 user+assistant 入队，轮末只补 tool_result）
  for await (const line of inputs) {
    const input = line.trim();
    if (!input) continue;
    if (input.startsWith("/")) {
      // 会话内命令（统一 / 前缀，DESIGN 15）
      if (input === "/exit") break;
      if (input === "/compact") {
        // 强制压缩：替换消息后重写整份落盘（压缩是重写不是追加，session 内存随之整体替换）
        if (await agent.compactNow()) {
          await store.rewriteMessages(session, agent.getMessages());
          agent.consumeHistoryRewritten(); // 消费压缩置位的历史改写标记，防下轮误报重写
          write("\n[已压缩] 会话历史已压缩，关键上下文已保留。\n");
        } else {
          write("\n[未压缩] 未配置压缩或摘要不可用。\n");
        }
        continue;
      }
      if (input === "/help") {
        write("\n可用命令：/exit 退出；/compact 压缩会话历史；/help 帮助\n");
        continue;
      }
      write(`\n[未知命令] ${input}（/help 查看可用命令）\n`);
      continue;
    }
    await hooks?.emit({ type: "UserPromptSubmit", input });
    // 本轮起点：回显工具结果时只回显本轮新增的（重写分支里历史可能被压缩替换）
    const roundStart = agent.getMessages().length;
    agent.start(input);
    // 渲染流式事件：文本与思考直接输出，工具调用与错误加标记（渲染归属调用方，此前确认）
    for await (const event of agent.run()) {
      render(event);
    }
    write("\n");
    // 历史被改写（压缩/裁剪/剥组）：agent 内存为真相，重写整份盘防落盘错位；
    // 否则只落盘本轮新增（checkpoint 已提前落盘过部分，这里补齐剩余）
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
    // 回显本轮工具结果（重写分支也要回显，不能因压缩吞掉工具输出）
    for (const message of agentMessages.slice(roundStart)) {
      if (message.role === "tool_result") {
        write(`\n[工具结果] ${message.content}\n`);
      }
    }
  }
}
