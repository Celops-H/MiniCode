import { describe, expect, it } from "vitest";
import { checkDangerousCommand } from "../../src/permission/index.js";

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
