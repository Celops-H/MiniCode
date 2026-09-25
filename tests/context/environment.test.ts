/**
 * 环境信息段测试（E80）：Shell 如实报告实际执行者——Windows 的 bash 工具经
 * spawn(shell:true) 实际由 cmd.exe 执行，报告 SHELL（Git Bash 启动时指向 bash）
 * 会诱导模型写 bash 语法命令。
 */
import { describe, expect, it } from "vitest";
import { environmentPrompt } from "../../src/context/index.js";

describe("environmentPrompt（环境信息段）", () => {
  it("Windows 下报告实际执行者 COMSPEC，不吃 SHELL（E80）", () => {
    const env = { ...process.env, SHELL: "/usr/bin/bash", COMSPEC: "C:\\Windows\\system32\\cmd.exe" };
    const prompt = environmentPrompt("C:\\proj", { env, platform: "win32" });
    expect(prompt).toContain("cmd.exe");
    expect(prompt).not.toContain("/usr/bin/bash");
    expect(prompt).not.toContain("PowerShell");
  });

  it("Windows 无 COMSPEC 时回落 cmd.exe 字面值", () => {
    const env = { ...process.env };
    delete env.COMSPEC;
    delete env.SHELL;
    const prompt = environmentPrompt("C:\\proj", { env, platform: "win32" });
    expect(prompt).toContain("cmd.exe");
  });

  it("POSIX 下报告 SHELL", () => {
    const env = { ...process.env, SHELL: "/bin/zsh" };
    const prompt = environmentPrompt("/home/u/proj", { env, platform: "linux" });
    expect(prompt).toContain("/bin/zsh");
  });

  it("包含工作目录与架构", () => {
    const prompt = environmentPrompt("/proj", { env: {}, platform: "linux" });
    expect(prompt).toContain("/proj");
    expect(prompt).toContain(process.arch);
  });
});
