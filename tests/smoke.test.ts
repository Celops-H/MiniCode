import { describe, expect, it } from "vitest";
import { program } from "../src/cli/index.js";

describe("CLI 冒烟测试", () => {
  it("定义 new / continue / list 命令", () => {
    const names = program.commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(["new", "continue", "list"]));
  });
});
