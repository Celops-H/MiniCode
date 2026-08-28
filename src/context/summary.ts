import {
  assembleAssistantMessage,
  createContext,
  userMessage,
  type Context,
  type Message,
  type StreamEvent,
} from "../core/index.js";

/** 摘要能力：由宿主（agent）注入模型流，把旧对话压成结构化摘要 */
export interface Summarizer {
  stream(
    modelId: string,
    context: Context,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<StreamEvent>;
}

/** 摘要调用的系统提示词：忠实压缩，不增不删 */
const SUMMARY_SYSTEM_PROMPT = "你是代码开发助手。请忠实压缩对话信息为结构化摘要，不添加、不遗漏关键细节。";

/**
 * 生成结构化摘要请求（DESIGN 9.3 六段格式）。
 * 结构参考主流 agent CLI 的压缩提示词融合而来：开头前言说明这是内部压缩调用、
 * 禁止调用工具（摘要只产出文本），末尾固定尾注；用户压缩指导以「Additional
 * Instructions」段追加在提示词最末（尾部追加，不替换任何小节，DESIGN 9.8）。
 * @param instructions 附加的压缩指导（如「侧重保留命令输出」），可选
 * @returns 摘要请求用户消息
 */
export function buildSummaryRequest(instructions?: string): Message {
  const guidance = instructions ? `\n\nAdditional Instructions：\n${instructions}` : "";
  const prompt = `以下是系统内部的压缩调用：请把以上对话压缩为结构化摘要，用于继续开发时恢复上下文。不要调用任何工具，只输出摘要正文。按以下六段组织：
1. 目标：用户想达成什么
2. 约束：必须遵守的约束与偏好
3. 进展：已完成的步骤与结果
4. 决策：关键设计决策及理由
5. 下一步：正在做或计划做的事
6. 关键上下文：涉及的文件、代码、命令等关键信息
只输出摘要正文，不要客套。${guidance}`;
  return userMessage(prompt);
}

/**
 * 用模型把消息压缩成摘要文本：摘要请求附在对话末尾，收集模型回复的文本。
 * @param client 模型流（Summarizer）
 * @param modelId 模型 id
 * @param messages 待压缩的对话消息
 * @param instructions 附加压缩指导（可省略），以 Additional Instructions 段追加提示词末尾
 * @returns 摘要文本
 */
export async function generateSummary(
  client: Summarizer,
  modelId: string,
  messages: Message[],
  instructions?: string,
  signal?: AbortSignal,
): Promise<string> {
  const context = createContext(SUMMARY_SYSTEM_PROMPT, [...messages, buildSummaryRequest(instructions)], []);
  const assistant = await assembleAssistantMessage(client.stream(modelId, context, { signal }));
  return assistant.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** 摘要消息的标记前缀（系统生成，source: "system"；增量合并时据此定位旧摘要） */
export const SUMMARY_MARKER = "【会话摘要】";

/**
 * 把旧对话替换为摘要消息（压缩结果）。
 * 摘要由系统生成而非用户输入，标记 source: "system"。
 * @param summary 摘要文本
 * @returns 替换后的消息数组（单条摘要用户消息）
 */
export function replaceWithSummary(summary: string): Message[] {
  return [userMessage(`${SUMMARY_MARKER}\n${summary}`, "system")];
}
