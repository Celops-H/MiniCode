import {
  assembleAssistantMessage,
  createContext,
  toolCallsOf,
  userMessage,
  type AssistantMessage,
  type Context,
  type Message,
  type StreamEvent,
} from "../core/index.js";
import { ToolRegistry, type Tool } from "../tools/index.js";

/** 模型客户端：主循环通过它调用模型（Models 集合或测试 mock 均满足） */
export interface ModelClient {
  stream(modelId: string, context: Context): AsyncIterable<StreamEvent>;
}

export interface AgentOptions {
  modelClient: ModelClient;
  modelId: string;
  systemPrompt: string;
  tools?: Tool[];
  /** 最大轮数，防止失控 */
  maxTurns?: number;
}

/** Agent 主循环：显式步骤序列，驱动模型对话与工具执行 */
export class Agent {
  private readonly modelClient: ModelClient;
  private readonly modelId: string;
  private readonly systemPrompt: string;
  private readonly maxTurns: number;
  private readonly registry: ToolRegistry;
  private readonly messages: Message[] = [];

  constructor(options: AgentOptions) {
    this.modelClient = options.modelClient;
    this.modelId = options.modelId;
    this.systemPrompt = options.systemPrompt;
    this.maxTurns = options.maxTurns ?? 10;
    this.registry = new ToolRegistry();
    for (const tool of options.tools ?? []) {
      this.registry.register(tool);
    }
  }

  /** 追加用户输入，开始新一轮对话 */
  start(input: string): void {
    this.messages.push(userMessage(input));
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * 主循环：组装上下文 → 流式调用模型 → 拼装回复 → 追加消息。
   * 透传模型流事件供外部渲染；无工具调用即结束（工具执行在后续阶段接入）。
   */
  async *run(): AsyncGenerator<StreamEvent> {
    for (let turn = 0; turn < this.maxTurns; turn++) {
      const context = createContext(this.systemPrompt, this.messages, this.registry.definitions());
      const collected: StreamEvent[] = [];
      for await (const event of this.modelClient.stream(this.modelId, context)) {
        collected.push(event);
        yield event;
      }
      const assistant: AssistantMessage = await assembleAssistantMessage(toAsyncIterable(collected));
      this.messages.push(assistant);

      if (toolCallsOf(assistant).length === 0) {
        return; // 无工具调用，对话结束
      }
      // 工具执行与结果回灌：后续阶段接入
      return;
    }
  }
}

function toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const item of items) yield item;
  })();
}
