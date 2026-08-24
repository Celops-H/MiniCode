import { describe, expect, it } from "vitest";
import { isReadOnlyBashCommand } from "../../src/tools/builtin/bash.js";

describe("isReadOnlyBashCommand（bash 只读判定）", () => {
  it("白名单内的简单命令判定为只读", () => {
    expect(isReadOnlyBashCommand("ls")).toBe(true);
    expect(isReadOnlyBashCommand("ls -la")).toBe(true);
    expect(isReadOnlyBashCommand("cat file.txt")).toBe(true);
    expect(isReadOnlyBashCommand("grep pattern src/a.ts")).toBe(true);
    expect(isReadOnlyBashCommand("find . -name '*.ts'")).toBe(true);
    expect(isReadOnlyBashCommand("echo hi")).toBe(true);
    expect(isReadOnlyBashCommand("echo $HOME")).toBe(true);
  });

  it("常见写命令不在白名单，判定为非只读", () => {
    expect(isReadOnlyBashCommand("rm file.txt")).toBe(false);
    expect(isReadOnlyBashCommand("mv a b")).toBe(false);
    expect(isReadOnlyBashCommand("mkdir dir")).toBe(false);
    expect(isReadOnlyBashCommand("cd /tmp")).toBe(false);
    expect(isReadOnlyBashCommand("git commit -m x")).toBe(false);
  });

  it("重定向、管道、连接符、后台、子 shell 判为非只读", () => {
    expect(isReadOnlyBashCommand("ls > out.txt")).toBe(false);
    expect(isReadOnlyBashCommand("cat < in.txt")).toBe(false);
    expect(isReadOnlyBashCommand("ls | wc")).toBe(false);
    expect(isReadOnlyBashCommand("ls && echo hi")).toBe(false);
    expect(isReadOnlyBashCommand("sleep 5 &")).toBe(false);
    expect(isReadOnlyBashCommand("(ls)")).toBe(false);
  });

  it("命令替换、变量赋值前缀判为非只读", () => {
    expect(isReadOnlyBashCommand("echo $(date)")).toBe(false);
    expect(isReadOnlyBashCommand("echo `date`")).toBe(false);
    expect(isReadOnlyBashCommand("FOO=1 ls")).toBe(false);
  });

  it("find 的危险标志（delete/exec/ok）判为非只读", () => {
    expect(isReadOnlyBashCommand("find . -delete")).toBe(false);
    expect(isReadOnlyBashCommand("find . -exec rm {} \\;")).toBe(false);
  });

  it("find 的 execdir/okdir/fprint 写操作判为非只读", () => {
    expect(isReadOnlyBashCommand("find . -execdir rm {} \\;")).toBe(false);
    expect(isReadOnlyBashCommand("find . -okdir rm {} \\;")).toBe(false);
    expect(isReadOnlyBashCommand("find . -fprint out.txt")).toBe(false);
    expect(isReadOnlyBashCommand("find . -fprintf out.txt '%p'")).toBe(false);
    expect(isReadOnlyBashCommand("find . -fprint0 out.txt")).toBe(false);
    expect(isReadOnlyBashCommand("find . -fls out.txt")).toBe(false);
    expect(isReadOnlyBashCommand("find . -ok rm {} \\;")).toBe(false);
  });

  it("多行命令（含换行）判为非只读（第二行可写）", () => {
    expect(isReadOnlyBashCommand("echo hi\nrm file.txt")).toBe(false);
    expect(isReadOnlyBashCommand("ls\r\nrm file.txt")).toBe(false);
  });

  it("空串判为非只读（保守）", () => {
    expect(isReadOnlyBashCommand("")).toBe(false);
    expect(isReadOnlyBashCommand("   ")).toBe(false);
  });
});
