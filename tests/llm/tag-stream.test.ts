import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../../src/core/index.js";
import { InlineTagFilter, PrefixDeltaGuard } from "../../src/llm/protocol/tag-stream.js";

/** 依次喂入多段文本，收集全部事件 */
function feed(filter: InlineTagFilter, ...chunks: string[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const chunk of chunks) events.push(...filter.push(chunk));
  events.push(...filter.flush());
  return events;
}

describe("InlineTagFilter（正文标签状态机）", () => {
  it("无标签的正文原样通过", () => {
    const f = new InlineTagFilter(() => 0);
    expect(feed(f, "你好", "世界")).toEqual([
      { type: "text_delta", text: "你好" },
      { type: "text_delta", text: "世界" },
    ]);
  });

  it("<thinking> 段转 thinking_delta，标签不进正文", () => {
    const f = new InlineTagFilter(() => 0);
    expect(feed(f, "前文<thinking>内部推理</thinking>后文")).toEqual([
      { type: "text_delta", text: "前文" },
      { type: "thinking_delta", thinking: "内部推理" },
      { type: "text_delta", text: "后文" },
    ]);
  });

  it("跨 chunk 拆开的标签能识别", () => {
    const f = new InlineTagFilter(() => 0);
    const events = feed(f, "<thi", "nking>推", "理</thi", "nking>完");
    // 段内容按到达顺序分片发出，消费端聚合
    expect(events).toEqual([
      { type: "thinking_delta", thinking: "推" },
      { type: "thinking_delta", thinking: "理" },
      { type: "text_delta", text: "完" },
    ]);
  });

  it("<tool_call> 段闭合时解析 JSON 转工具调用事件，占用分配的序号", () => {
    let next = 5;
    const f = new InlineTagFilter(() => next++);
    const events = feed(
      f,
      '<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>',
    );
    expect(events).toEqual([
      { type: "toolcall_start", index: 5, id: "inline_5", name: "read" },
      { type: "toolcall_delta", index: 5, partialJson: '{"path":"a.ts"}' },
      { type: "toolcall_end", index: 5 },
    ]);
    expect(next).toBe(6);
  });

  it("arguments 为字符串形状时再解析一层", () => {
    const f = new InlineTagFilter(() => 0);
    const events = feed(
      f,
      '<tool_call>{"name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}</tool_call>',
    );
    expect(events[0]).toMatchObject({ type: "toolcall_start", name: "read" });
    expect(events[1]).toEqual({ type: "toolcall_delta", index: 0, partialJson: '{"path":"a.ts"}' });
  });

  it("标签内 JSON 解析失败：原文按正文发出，内容不丢", () => {
    const f = new InlineTagFilter(() => 0);
    const events = feed(f, "<tool_call>不是JSON</tool_call>");
    expect(events).toEqual([{ type: "text_delta", text: "<tool_call>不是JSON</tool_call>" }]);
  });

  it("裸 < 不属于任何标签时按正文字符发出", () => {
    const f = new InlineTagFilter(() => 0);
    expect(feed(f, "a < b")).toEqual([
      { type: "text_delta", text: "a " },
      { type: "text_delta", text: "<" },
      { type: "text_delta", text: " b" },
    ]);
  });

  it("流结束时未闭合的 thinking 段残料按思考发出，未闭合 tool_call 段按正文发出", () => {
    const thinkingFilter = new InlineTagFilter(() => 0);
    expect(feed(thinkingFilter, "<thinking>半截")).toEqual([
      { type: "thinking_delta", thinking: "半截" },
    ]);
    const toolFilter = new InlineTagFilter(() => 0);
    expect(feed(toolFilter, "x<tool_call>{\"name\":\"a\"}")).toEqual([
      { type: "text_delta", text: "x" },
      { type: "text_delta", text: "<tool_call>{\"name\":\"a\"}" },
    ]);
  });

  it("空串输入不产出事件", () => {
    const f = new InlineTagFilter(() => 0);
    expect(feed(f, "", "")).toEqual([]);
  });
});

describe("PrefixDeltaGuard（累积全文防滚雪球）", () => {
  it("厂商发累积全文时剥离已发前缀，只发余量", () => {
    const g = new PrefixDeltaGuard();
    expect(g.next("AB")).toBe("AB");
    expect(g.next("ABC")).toBe("C");
    expect(g.next("ABCD")).toBe("D");
    expect(g.next("ABCD")).toBe("");
  });

  it("正常增量流原样通过（不受防重复影响）", () => {
    const g = new PrefixDeltaGuard();
    expect(g.next("你")).toBe("你");
    expect(g.next("好")).toBe("好");
    expect(g.next("!")).toBe("!");
  });

  it("前缀不匹配时原样透传并续接累积", () => {
    const g = new PrefixDeltaGuard();
    expect(g.next("abc")).toBe("abc");
    expect(g.next("xyz")).toBe("xyz"); // 不匹配：透传，累积变 "abcxyz"
    expect(g.next("abcxyz!")).toBe("!"); // 后续累积全文再匹配，只发余量
  });
});
