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

/** 交互循环：逐行读取输入 → Agent 跑 → 增量输出 → 消息持久化 */
export async function interact(options: InteractOptions): Promise<void> {
  const { agent, store, session, inputs, write } = options;
  // 已持久化的消息游标（含续跑时注入的历史），每轮只落盘增量
  let processed = agent.getMessages().length;
  for await (const line of inputs) {
    const input = line.trim();
    if (!input) continue;
    if (input === "/exit") break; // 退出交互
    agent.start(input);
    for await (const event of agent.run()) {
      if (event.type === "text_delta") write(event.text);
    }
    write("\n");
    const newMessages = agent.getMessages().slice(processed);
    for (const message of newMessages) {
      await store.appendMessage(session, message);
    }
    processed = agent.getMessages().length;
  }
}
