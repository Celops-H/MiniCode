import type { StreamEvent } from "../../core/index.js";

/**
 * 正文流入站清洗：标签状态机 + 增量前缀剥离。
 *
 * 标签状态机的背景：请求侧把历史思考块退化为 `<thinking>...</thinking>` 文本（无
 * signature / 字段回传能力的厂商），部分模型会模仿该格式在正文里输出标签，正文里
 * 还会出现 `<tool_call>` 标签形式的工具调用。状态机把这两类标签转回对应事件：
 * - `<thinking>...</thinking>` 段 → thinking_delta，标签本身不进正文
 * - `<tool_call>{JSON}</tool_call>` 段 → 闭合时解析 JSON 转成 toolcall_start/delta/end；
 *   JSON 解析失败把标签内原文按正文发出（内容不丢）
 * 状态机按 chunk 增量扫描，跨 chunk 拆开的标签也能识别（缓冲可能成标签前缀的尾部）。
 *
 * 前缀剥离器的背景：个别厂商把正文/思考以「累积全文」而非增量下发，逐 chunk 原样
 * 透传会滚雪球重复。chunk 恰以已发全文为前缀时只发余量，否则原样透传——正常增量流
 * 不受影响。权衡：极端巧合下（下一增量恰好重复此前全文）会误剥，概率远低于滚雪球
 * 本身的破坏。
 */

/** `<tool_call>` 标签内 JSON 解析出的工具调用 */
interface InlineToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** 标签状态机当前所处段落 */
type TagMode = "normal" | "thinking" | "toolcall";

const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";
const TOOLCALL_OPEN = "<tool_call>";
const TOOLCALL_CLOSE = "</tool_call>";

/** 开标签清单：normal 态按出现位置匹配（两者互不为前缀，匹配互不干扰） */
const OPEN_TAGS = [TOOLCALL_OPEN, THINKING_OPEN] as const;

export class InlineTagFilter {
  private mode: TagMode = "normal";
  /** 未定缓冲：normal 态是可能成标签前缀的尾部，thinking/toolcall 态是段内容 */
  private buf = "";
  /** 标签工具调用的分配序号（与协议原生工具调用共用计数器，防撞号） */
  private readonly allocateToolIndex: () => number;

  constructor(allocateToolIndex: () => number) {
    this.allocateToolIndex = allocateToolIndex;
  }

  /**
   * 喂一段正文增量，返回清洗后应发出的事件（0 到多个）。
   * @param text 原始正文增量
   * @returns 清洗后的事件序列
   */
  push(text: string): StreamEvent[] {
    this.buf += text;
    const events: StreamEvent[] = [];
    // 循环推进直到缓冲只剩「等待更多数据」的残料；每轮至少消费或缓冲 1 字符，不会死循环
    for (;;) {
      if (this.mode === "thinking") {
        const closeIdx = this.buf.indexOf(THINKING_CLOSE);
        if (closeIdx >= 0) {
          const content = this.buf.slice(0, closeIdx);
          if (content) events.push({ type: "thinking_delta", thinking: content });
          this.buf = this.buf.slice(closeIdx + THINKING_CLOSE.length);
          this.mode = "normal";
          continue;
        }
        // 未见闭合标签：发出确定不属于闭合标签前缀的部分，缓冲可能是 `</thinking>` 前缀的尾部
        const hold = holdbackLength(this.buf, THINKING_CLOSE);
        const safe = this.buf.slice(0, this.buf.length - hold);
        if (safe) events.push({ type: "thinking_delta", thinking: safe });
        this.buf = this.buf.slice(this.buf.length - hold);
        return events;
      }
      if (this.mode === "toolcall") {
        const closeIdx = this.buf.indexOf(TOOLCALL_CLOSE);
        if (closeIdx < 0) return events; // 段未闭合：整体缓冲（单次工具调用有界），等闭合再解析
        const raw = this.buf.slice(0, closeIdx);
        this.buf = this.buf.slice(closeIdx + TOOLCALL_CLOSE.length);
        this.mode = "normal";
        events.push(...this.emitInlineToolCall(raw));
        continue;
      }
      // normal 态：先发完标签前的正文，再尝试识别开标签
      const openIdx = this.buf.indexOf("<");
      if (openIdx < 0) {
        if (this.buf) events.push({ type: "text_delta", text: this.buf });
        this.buf = "";
        return events;
      }
      if (openIdx > 0) {
        events.push({ type: "text_delta", text: this.buf.slice(0, openIdx) });
        this.buf = this.buf.slice(openIdx);
      }
      // 缓冲以 "<" 开头：匹配完整开标签，或缓冲等待（可能是被拆开的开标签前缀）
      const openTag = OPEN_TAGS.find((t) => this.buf.startsWith(t));
      if (openTag) {
        this.buf = this.buf.slice(openTag.length);
        this.mode = openTag === THINKING_OPEN ? "thinking" : "toolcall";
        continue;
      }
      if (OPEN_TAGS.some((t) => t.startsWith(this.buf))) return events; // 半截开标签：等更多数据
      // 不是标签开头的裸 "<"：按正文字符发出，继续扫描
      events.push({ type: "text_delta", text: "<" });
      this.buf = this.buf.slice(1);
    }
  }

  /**
   * 流（或文本块）结束：未闭合的残料按当前形态原文发出，不做标签转换。
   * @returns 收尾事件序列
   */
  flush(): StreamEvent[] {
    const rest = this.buf;
    this.buf = "";
    if (!rest) return [];
    if (this.mode === "thinking") return [{ type: "thinking_delta", thinking: rest }];
    // 未闭合的 tool_call 段带开标签按正文发出（保留意图痕迹，内容不丢）
    return [{ type: "text_delta", text: `${TOOLCALL_OPEN}${rest}` }];
  }

  /**
   * 解析 `<tool_call>` 段内容并转成工具调用事件；解析失败按正文原文发出。
   * @param raw 标签内的原始文本
   * @returns 事件序列
   */
  private emitInlineToolCall(raw: string): StreamEvent[] {
    const parsed = parseInlineToolCall(raw);
    if (!parsed) return [{ type: "text_delta", text: `${TOOLCALL_OPEN}${raw}${TOOLCALL_CLOSE}` }];
    const index = this.allocateToolIndex();
    return [
      { type: "toolcall_start", index, id: `inline_${index}`, name: parsed.name },
      { type: "toolcall_delta", index, partialJson: JSON.stringify(parsed.input) },
      { type: "toolcall_end", index },
    ];
  }
}

/**
 * 正文/思考增量的前缀剥离器：厂商发累积全文时剥离已发前缀，正常增量原样通过。
 */
export class PrefixDeltaGuard {
  private prev = "";

  /**
   * 处理下一段增量。
   * @param chunk 厂商发来的原始增量
   * @returns 应实际发出的文本（可能为空串）
   */
  next(chunk: string): string {
    if (this.prev && chunk.startsWith(this.prev)) {
      const rest = chunk.slice(this.prev.length);
      this.prev = chunk;
      return rest;
    }
    this.prev += chunk;
    return chunk;
  }
}

/**
 * 计算 normal/thinking 模式下需要保留等待的尾部长度：缓冲尾部若是 closeTag 的真前缀
 * （可能被下一个 chunk 补全成闭合标签），保留等待；否则不保留。
 * @param buf 当前缓冲
 * @param closeTag 闭合标签全文
 * @returns 需保留的尾部长度（0 到 closeTag.length - 1）
 */
function holdbackLength(buf: string, closeTag: string): number {
  const max = Math.min(buf.length, closeTag.length - 1);
  for (let len = max; len > 0; len--) {
    if (closeTag.startsWith(buf.slice(buf.length - len))) return len;
  }
  return 0;
}

/**
 * 解析 `<tool_call>` 标签内的 JSON：name/arguments，arguments 兼容对象与字符串两种形状
 * （字符串再解析一层），也接受 function 包裹形态。
 * @param raw 标签内原始文本
 * @returns 解析结果；形状不对或解析失败返回 null
 */
function parseInlineToolCall(raw: string): InlineToolCall | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const record = obj as Record<string, unknown>;
  const fn = (record.function ?? null) as Record<string, unknown> | null;
  const name = record.name ?? record.tool ?? fn?.name;
  if (typeof name !== "string" || !name) return null;
  let args = record.arguments ?? record.parameters ?? record.input ?? fn?.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  return { name, input: args as Record<string, unknown> };
}
