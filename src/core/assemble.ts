import { randomUUID } from "node:crypto";
import type { AssistantMessage, ContentBlock, ModelUsage } from "./message.js";
import type { StreamEvent } from "./events.js";

/**
 * 事件收集器：消费统一事件流，把增量拼装为 AssistantMessage。
 * 内容块按思考 → 文本 → 工具调用排列（与厂商原生块序一致）；思考按序号分组
 * （无序号的增量归同一块），签名与加密数据并进对应思考块；工具调用按 index
 * 分组收集参数片段，
 * 结束后拼接成 JSON 字符串解析为对象。
 * @param stream 统一事件流（text / thinking / toolcall 增量与 done / error）
 * @returns 拼装完成的模型回复消息
 */
export async function assembleAssistantMessage(
  stream: AsyncIterable<StreamEvent>,
): Promise<AssistantMessage> {
  const textParts: string[] = [];
  // 思考块按 index 分组（插入序 = 到达序）：anthropic 一响应可含多个思考块，
  // 签名按同序号归入对应块；无 index 的思考（openai 链）共用缺省组，拼成单块
  const thinkingGroups = new Map<
    number | undefined,
    { text: string[]; signature?: string; redactedData?: string }
  >();
  /** 取思考组（不存在则建）：insertion 顺序即内容块顺序 */
  const thinkingGroup = (index: number | undefined) => {
    let group = thinkingGroups.get(index);
    if (!group) {
      group = { text: [] };
      thinkingGroups.set(index, group);
    }
    return group;
  };
  // 按工具调用 index 分组：id / name 来自 start 事件，参数来自 delta 事件
  const toolCalls = new Map<number, { id?: string; name?: string; json: string[] }>();
  let stopReason: string | undefined;
  let error: string | undefined;
  // 真实用量：随 done 事件到达，回填 meta.usage 供观测与压缩阈值校准
  let usage: ModelUsage | undefined;

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        // 空片段不聚（协议层已守卫，此处兜底）：全空流不产出空内容块
        if (event.text) textParts.push(event.text);
        break;
      case "thinking_delta": {
        if (!event.thinking) break;
        const group = thinkingGroup(event.index);
        group.text.push(event.thinking);
        break;
      }
      case "thinking_signature": {
        // 签名增量并入同序号思考块（多段增量拼接；anthropic 通常整段一次到达）
        const group = thinkingGroup(event.index);
        group.signature = (group.signature ?? "") + event.signature;
        break;
      }
      case "redacted_thinking": {
        // 加密思考块整块到达（无明文增量）：覆盖写，同序号以最后一片为准
        const group = thinkingGroup(event.index);
        group.redactedData = event.data;
        break;
      }
      case "toolcall_start": {
        const entry = toolCalls.get(event.index) ?? { json: [] };
        if (event.id !== undefined) entry.id = event.id;
        if (event.name !== undefined) entry.name = event.name;
        toolCalls.set(event.index, entry);
        break;
      }
      case "toolcall_delta": {
        if (!event.partialJson) break;
        const entry = toolCalls.get(event.index) ?? { json: [] };
        entry.json.push(event.partialJson);
        toolCalls.set(event.index, entry);
        break;
      }
      case "done":
        stopReason = event.stopReason;
        usage = event.usage;
        break;
      case "error":
        error = event.message;
        break;
      default:
        break;
    }
  }

  // 按固定顺序组装内容块：思考 → 文本 → 工具调用（按 index 升序）。
  // 思考在文本之前与厂商原生块序一致（anthropic 的思考块先于正文产出，同模型
  // 回传时最后一条 assistant 须以 thinking 块开头）；拼接后 trim 为空的不产生
  // 内容块：部分厂商对无思考的轮发占位思考增量（glm-4.5-air 工具循环续轮发
  // reasoning_content="\n"），如实组装会渲染出展开全空白的「思考」折叠块；
  // 正文纯空白同理处理
  const content: ContentBlock[] = [];
  for (const group of thinkingGroups.values()) {
    const thinking = group.text.join("");
    // 加密思考块：无明文也保留（同模型回传时厂商侧解密），签名不随此类块出现
    if (group.redactedData !== undefined) {
      content.push({ type: "thinking", thinking: "", redactedData: group.redactedData });
      continue;
    }
    if (thinking.trim()) {
      content.push({
        type: "thinking",
        thinking,
        ...(group.signature ? { signature: group.signature } : {}),
      });
    }
  }
  const text = textParts.join("");
  if (text.trim()) {
    content.push({ type: "text", text });
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

  // 有停因或错误时记入 meta，供后续观测与续跑；真实用量一并回填
  const meta = stopReason ?? error;
  return {
    role: "assistant",
    id: randomUUID(),
    content,
    timestamp: new Date().toISOString(),
    ...(meta
      ? { meta: { stopReason: stopReason ?? `error: ${error}`, ...(usage ? { usage } : {}) } }
      : {}),
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
