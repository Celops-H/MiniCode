import type { Agent } from "../agent/index.js";
import type { Session, SessionStore } from "../storage/index.js";

export interface InteractOptions {
  agent: Agent;
  store: SessionStore;
  session: Session;
  /** 输入行迭代（CLI 里是 readline 每行一个输入） */
  inputs: AsyncIterable<string>;
  /** 输出函数（CLI 里写 stdout） */
  write: (text: string) => void;
}

/**
 * 交互循环：逐行读取输入 → Agent 跑 → 增量渲染（文本/思考/工具调用/错误）→
 * 展示工具结果 → 消息持久化。
 * @param options 交互选项（agent / store / session / inputs / write）
 */
export async function interact(options: InteractOptions): Promise<void> {
  const { agent, store, session, inputs, write } = options;
  // 已持久化的消息游标（含续跑时注入的历史），每轮只落盘增量
  let processed = agent.getMessages().length;
  for await (const line of inputs) {
    const input = line.trim();
    if (!input) continue;
    if (input === "/exit") break; // 退出交互
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
    // 工具结果是回灌消息（非事件），本轮结束后展示并持久化
    const newMessages = agent.getMessages().slice(processed);
    for (const message of newMessages) {
      if (message.role === "tool_result") {
        write(`\n[工具结果] ${message.content}\n`);
      }
      await store.appendMessage(session, message);
    }
    processed = agent.getMessages().length;
  }
}
