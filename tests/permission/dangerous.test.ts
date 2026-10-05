import { describe, expect, it } from "vitest";
import { checkDangerousCommand, resolveCommandShell } from "../../src/permission/index.js";

describe("危险命令检测", () => {
  it("普通命令安全", () => {
    expect(checkDangerousCommand("ls -la")).toEqual({ dangerous: false });
    expect(checkDangerousCommand("git status")).toEqual({ dangerous: false });
    expect(checkDangerousCommand("echo hello")).toEqual({ dangerous: false });
  });

  it("eval / source 视为危险内建", () => {
    expect(checkDangerousCommand('eval "rm -rf /"').dangerous).toBe(true);
    expect(checkDangerousCommand("source script.sh").dangerous).toBe(true);
  });

  it(". 作为 source 别名危险，但隐藏文件不误报", () => {
    expect(checkDangerousCommand(". script.sh").dangerous).toBe(true);
    expect(checkDangerousCommand(".env").dangerous).toBe(false);
  });

  it("命令替换危险", () => {
    expect(checkDangerousCommand("echo $(whoami)").dangerous).toBe(true);
    expect(checkDangerousCommand("echo `whoami`").dangerous).toBe(true);
  });

  it("进程替换危险", () => {
    expect(checkDangerousCommand("diff <(ls) <(ls)").dangerous).toBe(true);
    expect(checkDangerousCommand("tee >(gzip > out.gz)").dangerous).toBe(true);
  });

  it("箭头函数与比较运算不误判进程替换（node -e 内联脚本常见写法）", () => {
    expect(checkDangerousCommand('node -e "arr.map(f=>({k:f}))"').dangerous).toBe(false);
    expect(checkDangerousCommand('node -e "if (a>=(b+1)) print()"').dangerous).toBe(false);
    expect(checkDangerousCommand('node -e "if (a<(b)) print()"').dangerous).toBe(false);
    expect(checkDangerousCommand("echo '<(ls)'").dangerous).toBe(false);
    // 真进程替换仍拦截
    expect(checkDangerousCommand("diff <(ls) <(ls)").dangerous).toBe(true);
  });

  it("引号外词中的进程替换不因 = 前缀豁免（bash 词中 <( >() 仍是真进程替换）", () => {
    expect(checkDangerousCommand("echo a=<(echo x)").dangerous).toBe(true);
    expect(checkDangerousCommand("echo a=>(echo x)").dangerous).toBe(true);
    expect(checkDangerousCommand("sed s/=>(/X/ file").dangerous).toBe(true);
    // 引号不配对：残段留在原文照常参与匹配，不漏检
    expect(checkDangerousCommand('diff <(ls) "unterminated').dangerous).toBe(true);
  });

  it("IFS 注入危险", () => {
    expect(checkDangerousCommand("IFS=; cat /etc/passwd").dangerous).toBe(true);
  });

  it("访问 /proc 危险", () => {
    expect(checkDangerousCommand("cat /proc/self/environ").dangerous).toBe(true);
  });

  it("返回危险原因", () => {
    const result = checkDangerousCommand('eval "x"');
    expect(result.dangerous).toBe(true);
    expect(result.reason).toContain("eval");
  });
});

describe("危险命令检测按实际 shell 判定", () => {
  it("resolveCommandShell 按 COMSPEC 可执行名归类（测试注入，不读进程）", () => {
    expect(resolveCommandShell({ platform: "linux" })).toBe("bash");
    expect(resolveCommandShell({ platform: "darwin" })).toBe("bash");
    // COMSPEC 缺省视为 cmd.exe（Node spawn(shell:true) 的缺省一致）
    expect(resolveCommandShell({ platform: "win32", env: {} })).toBe("cmd");
    expect(resolveCommandShell({ platform: "win32", env: { COMSPEC: "C:\\Windows\\system32\\cmd.exe" } })).toBe("cmd");
    expect(
      resolveCommandShell({ platform: "win32", env: { COMSPEC: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" } }),
    ).toBe("powershell");
    expect(
      resolveCommandShell({
        platform: "win32",
        env: { COMSPEC: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
      }),
    ).toBe("powershell");
    // 误把 COMSPEC 指到 POSIX shell 的罕见配置按 bash 保守全拦
    expect(resolveCommandShell({ platform: "win32", env: { COMSPEC: "C:\\Program Files\\Git\\bin\\bash.exe" } })).toBe(
      "bash",
    );
  });

  it("cmd 无命令替换与进程替换语法：符号是字面字符，不拦", () => {
    expect(checkDangerousCommand("echo $(whoami)", "cmd").dangerous).toBe(false);
    expect(checkDangerousCommand("echo `whoami`", "cmd").dangerous).toBe(false);
    // E171 实测误报场景：node -e 写测试文件，命令含反引号模板字符串
    expect(checkDangerousCommand('node -e "const t = `x${y}`"', "cmd").dangerous).toBe(false);
    expect(checkDangerousCommand("diff <(ls) <(ls)", "cmd").dangerous).toBe(false);
    expect(checkDangerousCommand("echo a=<(echo x)", "cmd").dangerous).toBe(false);
    // IFS 与 /proc 是 POSIX 概念，cmd 下同样只是字面文本
    expect(checkDangerousCommand("echo IFS=x", "cmd").dangerous).toBe(false);
    expect(checkDangerousCommand("cat /proc/self/environ", "cmd").dangerous).toBe(false);
    // 内建命令黑名单不分 shell，照常生效
    expect(checkDangerousCommand("eval x", "cmd").dangerous).toBe(true);
  });

  it("PowerShell 下 $() 与反引号仍拦，进程替换不拦（bash 专属语法）", () => {
    expect(checkDangerousCommand("echo $(whoami)", "powershell").dangerous).toBe(true);
    expect(checkDangerousCommand("echo `whoami`", "powershell").dangerous).toBe(true);
    expect(checkDangerousCommand("diff <(ls) <(ls)", "powershell").dangerous).toBe(false);
    expect(checkDangerousCommand("cat /proc/self/environ", "powershell").dangerous).toBe(false);
  });

  it("bash 语义各模式照常拦：缺省行为不变", () => {
    expect(checkDangerousCommand("echo $(whoami)").dangerous).toBe(true);
    expect(checkDangerousCommand("diff <(ls)", "bash").dangerous).toBe(true);
    expect(checkDangerousCommand("IFS=; cat /etc/passwd", "bash").dangerous).toBe(true);
    expect(checkDangerousCommand("cat /proc/self/environ", "bash").dangerous).toBe(true);
  });

  it("PowerShell 的 iex 与 eval 同类拦截，内建名不分大小写", () => {
    expect(checkDangerousCommand('iex "Remove-Item x"', "cmd").dangerous).toBe(true);
    expect(checkDangerousCommand("Invoke-Expression Get-Content f", "cmd").dangerous).toBe(true);
    expect(checkDangerousCommand("EVAL x", "cmd").dangerous).toBe(true);
    // 内建黑名单不分 shell，cmd 下照常生效
    expect(checkDangerousCommand("eval x", "cmd").dangerous).toBe(true);
  });

  it("COMSPEC 空串与缺失同样回退 cmd.exe（与 Node spawn 行为一致）", () => {
    expect(resolveCommandShell({ platform: "win32", env: { COMSPEC: "" } })).toBe("cmd");
  });
});
