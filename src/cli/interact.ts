import type { Agent } from "../agent/index.js";
import type { Session, SessionStore } from "../storage/index.js";
import type { HookBus } from "../hooks/index.js";

export interface InteractOptions {
  agent: Agent;
  store: SessionStore;
  session: Session;
  /** 输入行迭代（CLI 里是 readline 每行一个输入） */
  inputs: AsyncIterable<string>;
  /** 输出函数（CLI 里写 stdout） */
  write: (text: string) => void;
  /** Hook 总线（宿主发射会话级事件的通道，DESIGN 13.3）；缺省不发射 */
  hooks?: HookBus;
}

/**
 * 交互循环：逐行读取输入 → Agent 跑 → 增量渲染（文本/思考/工具调用/错误）→
 * 展示工具结果 → 消息持久化。
 * 会话内命令（统一 / 前缀，DESIGN 15）：/exit 退出、/compact 强制压缩并重写落盘、
 * /help 列出命令；UserPromptSubmit 由宿主（本函数）在每次输入后发射（DESIGN 13.3）。
 * @param options 交互选项（agent / store / session / inputs / write / hooks）
 */
export async function interact(options: InteractOptions): Promise<void> {
  const { agent, store, session, inputs, write, hooks } = options;
  // 已持久化的消息游标（含续跑时注入的历史），每轮只落盘增量
  let processed = agent.getMessages().length;
  for await (const line of inputs) {
    const input = line.trim();
    if (!input) continue;
    if (input.startsWith("/")) {
      // 会话内命令（统一 / 前缀，DESIGN 15）
      if (input === "/exit") break;
      if (input === "/compact") {
        // 强制压缩：替换消息后重写整份落盘并重置游标（压缩是重写不是追加，游标需联动）
        if (await agent.compactNow()) {
          await store.rewriteMessages(session, agent.getMessages());
          processed = agent.getMessages().length;
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
    agent.start(input);
    // 渲染流式事件：文本与思考直接输出，工具调用与错误加标记
    for await (const event of agent.run()) {
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
    write("\n");
    // 工具结果是回灌消息（非事件），本轮结束后展示并入队
    const newMessages = agent.getMessages().slice(processed);
    for (const message of newMessages) {
      if (message.role === "tool_result") {
        write(`\n[工具结果] ${message.content}\n`);
      }
      await store.appendMessage(session, message);
    }
    // 强制落盘（checkpoint）：本轮消息已入队，flush 后下轮模型请求前历史在盘上
    await store.flush();
    processed = agent.getMessages().length;
  }
}
