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
