/**
 * 复制到剪贴板（B-4 编码修复）：PowerShell 显式 UTF8 解码 stdin——默认 OEM 代码页
 * 会把中文/emoji 变乱码（问题 38）。mock spawn 断言命令参数与传入原文。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const spawnMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock.spawn }));

import { copyToClipboard } from "../../src/tui/loop.js";

function mockChild() {
  const stdinEnd = vi.fn();
  const child = { on: vi.fn(), stdin: { end: stdinEnd } };
  spawnMock.spawn.mockReturnValue(child);
  return { child, stdinEnd };
}

describe("copyToClipboard（B-4 非 ASCII 不乱码）", () => {
  beforeEach(() => spawnMock.spawn.mockClear());

  it("命令显式 UTF8 解码 stdin（而非 OEM 代码页默认），中文/emoji 不变成乱码", () => {
    mockChild();
    copyToClipboard("中文 emoji 🎉 内容");
    const [, args] = spawnMock.spawn.mock.calls[0] as [string, string[]];
    const command = args.join(" ");
    // B-4 根因：旧实现直接 Set-Clipboard 经 stdin（OEM 代码页解码）→ 非 ASCII 乱码；
    // 新实现先设 [Console]::InputEncoding = UTF8 再读 stdin
    expect(command).toContain("[Console]::InputEncoding = [System.Text.Encoding]::UTF8");
    expect(command).toContain("Set-Clipboard -Value ([Console]::In.ReadToEnd())");
  });

  it("stdin 收到原始文本（不做任何编码改写，UTF8 原样交给 PowerShell）", () => {
    const { stdinEnd } = mockChild();
    copyToClipboard("含中文的代码：const 变量 = 42");
    expect(stdinEnd).toHaveBeenCalledWith("含中文的代码：const 变量 = 42");
  });

  it("复制失败不打断（powershell 缺失等环境异常静默）", () => {
    const { child } = mockChild();
    copyToClipboard("x");
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
  });
});
