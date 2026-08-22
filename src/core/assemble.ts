import { randomUUID } from "node:crypto";
import type { AssistantMessage, ContentBlock } from "./message.js";
import type { StreamEvent } from "./events.js";

/**
 * 事件收集器：消费统一事件流，把增量拼装为 AssistantMessage。
 * 文本与思考各自聚合成一个块；工具调用按 index 分组收集参数片段，
 * 结束后拼接成 JSON 字符串解析为对象。
 * @param stream 统一事件流（text / thinking / toolcall 增量与 done / error）
 * @returns 拼装完成的模型回复消息
 */
export async function assembleAssistantMessage(
  stream: AsyncIterable<StreamEvent>,
): Promise<AssistantMessage> {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  // 按工具调用 index 分组：id / name 来自 start 事件，参数来自 delta 事件
  const toolCalls = new Map<number, { id?: string; name?: string; json: string[] }>();
  let stopReason: string | undefined;
  let error: string | undefined;

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        textParts.push(event.text);
        break;
      case "thinking_delta":
        thinkingParts.push(event.thinking);
        break;
      case "toolcall_start": {
        const entry = toolCalls.get(event.index) ?? { json: [] };
        if (event.id !== undefined) entry.id = event.id;
        if (event.name !== undefined) entry.name = event.name;
        toolCalls.set(event.index, entry);
        break;
      }
      case "toolcall_delta": {
        const entry = toolCalls.get(event.index) ?? { json: [] };
        entry.json.push(event.partialJson);
        toolCalls.set(event.index, entry);
        break;
      }
      case "done":
        stopReason = event.stopReason;
        break;
      case "error":
        error = event.message;
        break;
      default:
        break;
    }
  }

  // 按固定顺序组装内容块：文本 → 思考 → 工具调用（按 index 升序）
  const content: ContentBlock[] = [];
  if (textParts.length > 0) {
    content.push({ type: "text", text: textParts.join("") });
  }
  if (thinkingParts.length > 0) {
    content.push({ type: "thinking", thinking: thinkingParts.join("") });
  }
  for (const index of [...toolCalls.keys()].sort((a, b) => a - b)) {
    const call = toolCalls.get(index)!;
    content.push({
      type: "tool_call",
      id: call.id ?? `call_${index}`,
      name: call.name ?? "unknown",
      input: parseArguments(call.json.join("")),
    });
  }

  // 有停因或错误时记入 meta，供后续观测与续跑
  const meta = stopReason ?? error;
  return {
    role: "assistant",
    id: randomUUID(),
    content,
    ...(meta ? { meta: { stopReason: stopReason ?? `error: ${error}` } } : {}),
  };
}

/**
 * 把拼接的 JSON 字符串解析为对象。
 * @param json 工具参数的 JSON 字符串（增量拼接后的完整串）
 * @returns 解析出的参数对象；非法或缺省时返回空对象
 */
function parseArguments(json: string): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
