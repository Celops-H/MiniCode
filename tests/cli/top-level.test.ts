/**
 * 层 1：顶层 TUI 形态识别（P6-1/2）——minicode 无参进 TUI 空态、minicode -c [id] 继续最近/指定、
 * minicode --no-agents 禁多 Agent；其余形态交 commander 分派子命令。
 * 守卫 F-1（审查修正）：commander 15 默认 action 与子命令混用不可靠（minicode tui 会被默认 action
 * 截走、顶层可选 option 的 -c <id> 报 too many arguments），顶层形态由 main 手动接管不交 commander；
 * tui 子命令自身的 -c 仍由 commander 处理（此处返回 null）。
 */
import { expect, it } from "vitest";
import { topLevelTui } from "../../src/cli/app.js";

it("无参：进 TUI 空态（启动不建会话，P6-1）", () => {
  expect(topLevelTui([])).toEqual({ agents: true });
});

it("-c 无值：继续最近活跃会话", () => {
  expect(topLevelTui(["-c"])).toEqual({ continueRecent: true, agents: true });
  expect(topLevelTui(["--continue"])).toEqual({ continueRecent: true, agents: true });
});

it("-c <id>：继续指定会话", () => {
  expect(topLevelTui(["-c", "abc123"])).toEqual({ sessionId: "abc123", agents: true });
  expect(topLevelTui(["--continue", "abc123"])).toEqual({ sessionId: "abc123", agents: true });
});

it("--continue=id 内联形式（commander 同款写法）", () => {
  expect(topLevelTui(["--continue=abc123"])).toEqual({ sessionId: "abc123", agents: true });
});

it("-c 配 --no-agents：继续且禁用多 Agent", () => {
  expect(topLevelTui(["-c", "--no-agents"])).toEqual({ continueRecent: true, agents: false });
  expect(topLevelTui(["-c", "abc", "--no-agents"])).toEqual({ sessionId: "abc", agents: false });
});

it("参数顺序无关：--no-agents 在 -c 前后等价（整体审视必改，防静默丢 continue）", () => {
  expect(topLevelTui(["--no-agents", "-c"])).toEqual({ continueRecent: true, agents: false });
  expect(topLevelTui(["--no-agents", "-c", "abc"])).toEqual({ sessionId: "abc", agents: false });
  expect(topLevelTui(["--no-agents", "--continue=abc"])).toEqual({ sessionId: "abc", agents: false });
});

it("空值统一按继续最近：-c 后空串 / --continue= 空内联（整体审视建议）", () => {
  expect(topLevelTui(["-c", ""])).toEqual({ continueRecent: true, agents: true });
  expect(topLevelTui(["--continue="])).toEqual({ continueRecent: true, agents: true });
});

it("--no-agents：禁多 Agent 进 TUI", () => {
  expect(topLevelTui(["--no-agents"])).toEqual({ agents: false });
});

it("子命令/帮助等形态返回 null（交 commander）", () => {
  expect(topLevelTui(["tui"])).toBeNull();
  expect(topLevelTui(["tui", "-c"])).toBeNull(); // tui 子命令的 -c 由 commander 处理
  expect(topLevelTui(["new"])).toBeNull();
  expect(topLevelTui(["list"])).toBeNull();
  expect(topLevelTui(["continue", "abc"])).toBeNull();
  expect(topLevelTui(["--help"])).toBeNull();
  expect(topLevelTui(["-h"])).toBeNull();
  expect(topLevelTui(["--version"])).toBeNull();
});
