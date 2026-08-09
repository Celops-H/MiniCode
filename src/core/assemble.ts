import type { AssistantMessage, ContentBlock } from "./message.js";
import type { StreamEvent } from "./events.js";

/**
 * 事件收集器：消费统一事件流，把 text / thinking / toolcall 增量拼装为 AssistantMessage。
 * 工具调用参数为增量 JSON，收集拼接后解析为对象。
 */
export async function assembleAssistantMessage(
  stream: AsyncIterable<StreamEvent>,
): Promise<AssistantMessage> {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
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

  const meta = stopReason ?? error;
  return {
    role: "assistant",
    content,
    ...(meta ? { meta: { stopReason: stopReason ?? `error: ${error}` } } : {}),
  };
}

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
