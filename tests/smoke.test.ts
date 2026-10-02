import { describe, expect, it } from "vitest";
import { program } from "../src/bootstrap/main.js";

describe("入口冒烟测试", () => {
  it("定义 list / tui 命令（new/continue 宿主已删，会话入口由顶层形态与 tui 子命令覆盖）", () => {
    const names = program.commands.map((c) => c.name());
    expect(names).toEqual(["list", "tui"]);
  });
});
