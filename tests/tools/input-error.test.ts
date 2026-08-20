import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatInputError } from "../../src/tools/index.js";

describe("formatInputError（参数校验错误格式化）", () => {
  it("缺失参数翻译为「缺失」", () => {
    const schema = z.object({ path: z.string(), limit: z.number() });
    const error = schema.safeParse({ path: "a.ts" }).error!;
    expect(formatInputError("read", error)).toContain("工具 read 参数不合法");
    expect(formatInputError("read", error)).toContain("参数 limit：缺失");
  });

  it("类型不匹配保留 zod 的期望/收到说明", () => {
    const schema = z.object({ path: z.string() });
    const error = schema.safeParse({ path: 123 }).error!;
    expect(formatInputError("read", error)).toContain(
      "参数 path：Invalid input: expected string, received number",
    );
  });

  it("未识别字段列出具体字段名", () => {
    const schema = z.object({ path: z.string() }).strict();
    const error = schema.safeParse({ path: "a.ts", extra: 1 }).error!;
    expect(formatInputError("read", error)).toContain("未识别字段 extra");
  });

  it("多个错误用分号连接", () => {
    const schema = z.object({ path: z.string(), offset: z.number() });
    const error = schema.safeParse({}).error!;
    const message = formatInputError("read", error);
    expect(message).toContain("参数 path：缺失");
    expect(message).toContain("参数 offset：缺失");
    expect(message.match(/缺失/g)!.length).toBe(2);
  });
});
