import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli/index.js";

describe("CLI 冒烟测试", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("main 输出 MiniCode 标识", () => {
    main();
    expect(logSpy).toHaveBeenCalledWith("MiniCode CLI");
  });
});
