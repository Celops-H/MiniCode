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

  it("白名单命令带写选项判为非只读（输出落盘或改系统状态），显示形态放行", () => {
    // 输出写入文件（含短选项取值与旗标同词的粘连形态）
    expect(isReadOnlyBashCommand("sort -o out.txt in.txt")).toBe(false);
    expect(isReadOnlyBashCommand("sort -oout.txt in.txt")).toBe(false);
    expect(isReadOnlyBashCommand("sort --output=out.txt in.txt")).toBe(false);
    expect(isReadOnlyBashCommand("sort /o out.txt in.txt")).toBe(false);
    expect(isReadOnlyBashCommand("tree -o out.txt src")).toBe(false);
    expect(isReadOnlyBashCommand("tree -oout.txt src")).toBe(false);
    expect(isReadOnlyBashCommand("file -C -m magic")).toBe(false);
    // 改系统状态或持久化写
    expect(isReadOnlyBashCommand('date -s "2020-01-01"')).toBe(false);
    expect(isReadOnlyBashCommand("date -s2020-01-01")).toBe(false);
    expect(isReadOnlyBashCommand("date --set=2020-01-01")).toBe(false);
    expect(isReadOnlyBashCommand("history -w history.txt")).toBe(false);
    // 无写选项的显示形态照常放行
    expect(isReadOnlyBashCommand("sort -n in.txt")).toBe(true);
    expect(isReadOnlyBashCommand("sort /opt/data.txt")).toBe(true);
    expect(isReadOnlyBashCommand("tree src")).toBe(true);
    expect(isReadOnlyBashCommand("file a.txt")).toBe(true);
    expect(isReadOnlyBashCommand("date +%Y")).toBe(true);
    expect(isReadOnlyBashCommand("date -u")).toBe(true);
    // -Iseconds 是 -I 的带值形态，不是 -s 写旗标，不误判
    expect(isReadOnlyBashCommand("date -Iseconds")).toBe(true);
    expect(isReadOnlyBashCommand("history")).toBe(true);
  });

  it("段首包装命令剥开后按真实命令词判定（env rm x 判非只读，env ls 放行）", () => {
    // 包装后的真实命令词不在白名单 → 非只读
    expect(isReadOnlyBashCommand("env rm x")).toBe(false);
    expect(isReadOnlyBashCommand("env -i rm x")).toBe(false);
    expect(isReadOnlyBashCommand("env find . -delete")).toBe(false);
    expect(isReadOnlyBashCommand("sudo mv a b")).toBe(false);
    expect(isReadOnlyBashCommand("timeout 10 rm x")).toBe(false);
    expect(isReadOnlyBashCommand("nice -n 5 rm x")).toBe(false);
    // 包装后的真实命令词在白名单且无写选项 → 只读
    expect(isReadOnlyBashCommand("env ls")).toBe(true);
    expect(isReadOnlyBashCommand("env -i ls")).toBe(true);
    expect(isReadOnlyBashCommand("env -u FOO ls")).toBe(true);
    expect(isReadOnlyBashCommand("sudo -u root ls")).toBe(true);
    expect(isReadOnlyBashCommand("timeout 10 ls")).toBe(true);
    expect(isReadOnlyBashCommand("nice -n 5 cat file.txt")).toBe(true);
    // 包装叠加白名单命令的写选项仍判非只读
    expect(isReadOnlyBashCommand("env sort -o out.txt in.txt")).toBe(false);
    // command -v/-V 只查询命令路径、不执行命令，无真实命令词，判非只读（保守）
    expect(isReadOnlyBashCommand("command -v ls")).toBe(false);
    // command 不带 -v/-V 时按其后的真实命令词判定
    expect(isReadOnlyBashCommand("command -p ls")).toBe(true);
    expect(isReadOnlyBashCommand("command -p rm x")).toBe(false);
    // 裸包装命令无真实命令词，判非只读（保守）
    expect(isReadOnlyBashCommand("env")).toBe(false);
    expect(isReadOnlyBashCommand("sudo")).toBe(false);
  });

  it("uniq 的第二操作数落盘判非只读，输出位是 stdout 或无输出位放行", () => {
    expect(isReadOnlyBashCommand("uniq in.txt out.txt")).toBe(false);
    expect(isReadOnlyBashCommand("uniq -c in.txt out.txt")).toBe(false);
    expect(isReadOnlyBashCommand("uniq -f 1 in.txt out.txt")).toBe(false);
    expect(isReadOnlyBashCommand("uniq - in.txt")).toBe(false);
    expect(isReadOnlyBashCommand("uniq in.txt")).toBe(true);
    expect(isReadOnlyBashCommand("uniq -c in.txt")).toBe(true);
    expect(isReadOnlyBashCommand("uniq -f 2 report.txt")).toBe(true);
    expect(isReadOnlyBashCommand("uniq in.txt -")).toBe(true);
    expect(isReadOnlyBashCommand("uniq")).toBe(true);
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
