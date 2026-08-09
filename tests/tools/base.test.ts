import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateInput } from "../../src/tools/index.js";
import type { Tool } from "../../src/tools/index.js";

const readTool: Tool = {
  name: "read",
  description: "读取文件内容",
  inputSchema: z.object({ path: z.string() }),
  isReadOnly: true,
  requiresUserInteraction: false,
  maxResultSizeChars: 1000,
  execute: (input) => {
    const { path } = validateInput<{ path: string }>(readTool, input);
    return `内容：${path}`;
  },
};

describe("工具基类", () => {
  it("合法输入校验通过并返回解析后的值", () => {
    expect(validateInput<{ path: string }>(readTool, { path: "a.ts" })).toEqual({ path: "a.ts" });
  });

  it("非法输入校验失败抛出", () => {
    expect(() => validateInput(readTool, { path: 123 })).toThrow();
  });

  it("工具属性声明正确", () => {
    expect(readTool).toMatchObject({
      name: "read",
      isReadOnly: true,
      requiresUserInteraction: false,
      maxResultSizeChars: 1000,
    });
  });

  it("execute 校验并执行", () => {
    expect(readTool.execute({ path: "a.ts" })).toBe("内容：a.ts");
  });
});
