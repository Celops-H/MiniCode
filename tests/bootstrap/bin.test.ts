/**
 * 层 1：bin 包装入口的 FFI 重启决策（P1）——检测与命令行组装是纯函数，
 * spawn/信号转发/退出码镜像走层 3 真机。
 */
import { describe, expect, it } from "vitest";
import { FFI_FLAG, needsFfiRestart, restartCommandArgv } from "../../src/bin/ffi.js";

describe("needsFfiRestart", () => {
  it("execArgv 无该 flag：需要重启注入", () => {
    expect(needsFfiRestart([])).toBe(true);
    expect(needsFfiRestart(["--max-old-space-size=4096"])).toBe(true);
  });

  it("execArgv 已带该 flag：直接进入正常入口，不重复重启", () => {
    expect(needsFfiRestart([FFI_FLAG])).toBe(false);
    expect(needsFfiRestart(["--max-old-space-size=4096", FFI_FLAG])).toBe(false);
  });
});

describe("restartCommandArgv", () => {
  it("保留既有 execArgv 参数、追加 FFI flag、其后接脚本路径与用户参数", () => {
    expect(restartCommandArgv(["--max-old-space-size=4096"], ["/node", "/app/bin/minicode.js", "-c", "abc"])).toEqual([
      "--max-old-space-size=4096",
      FFI_FLAG,
      "/app/bin/minicode.js",
      "-c",
      "abc",
    ]);
  });

  it("无附加参数时最小形态：flag 直接落在脚本路径前（flag 必须先于脚本）", () => {
    expect(restartCommandArgv([], ["/node", "/app/bin/minicode.js"])).toEqual([FFI_FLAG, "/app/bin/minicode.js"]);
  });
});
