/**
 * bash 工具的平台与语法提示（E253）：Windows 下 bash 工具经 spawn(shell:true) 由 COMSPEC 执行，
 * Git Bash 环境里 SHELL 指向 bash，模型照它写 Unix 命令会当场失败。这里钉住描述按实际执行方归类，
 * 且描述确实带上当前平台的提示、排在非交互说明之前。
 */
import { describe, expect, it } from "vitest";
import { bashShellNote } from "../../src/tools/builtin/bash.js";
import { bashTool } from "../../src/tools/index.js";
import { resolveCommandShell } from "../../src/permission/index.js";

describe("bash 工具：描述写明平台与可用语法", () => {
  it("cmd 语义：标明 Windows 与 cmd.exe，点出 $()、单引号不生效，Unix 命令不保证可用并给替代", () => {
    const note = bashShellNote("cmd");
    expect(note).toContain("当前平台 Windows");
    expect(note).toContain("cmd.exe");
    expect(note).toContain("$()");
    expect(note).toContain("单引号");
    // Git Bash 启动时 PATH 常含 usr\bin，ls/grep 一类命令可能真的在，措辞不下绝对结论
    expect(note).toContain("不保证可用");
    // 替代方案：cmd 的 dir/type 与内置 grep、read
    expect(note).toContain("dir");
    expect(note).toContain("type");
    expect(note).toContain("内置 grep");
    expect(note).toContain("read");
  });

  it("powershell 语义：标明 Windows 与 PowerShell 语法，grep 给 Select-String 替代", () => {
    const note = bashShellNote("powershell");
    expect(note).toContain("当前平台 Windows");
    expect(note).toContain("PowerShell");
    expect(note).toContain("Select-String");
    expect(note).toContain("内置 grep");
  });

  it("bash 语义：标明 POSIX shell 与可用语法，不写 Windows 限制", () => {
    const note = bashShellNote("bash");
    expect(note).toContain("POSIX shell");
    expect(note).toContain("$()");
    expect(note).not.toContain("Windows");
  });

  it("描述按当前平台归类：带上当前 shell 的提示，并排在非交互说明之前", () => {
    const note = bashShellNote(resolveCommandShell());
    expect(bashTool.description).toContain(note);
    expect(bashTool.description.indexOf(note)).toBeLessThan(bashTool.description.indexOf("非交互"));
  });
});
