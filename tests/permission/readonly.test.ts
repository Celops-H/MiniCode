import { describe, expect, it } from "vitest";
import { readOnlyToolViolation, type CommandShellKind } from "../../src/permission/index.js";

describe("只读 agent 写拦截判定", () => {
  it("按工具元数据判定：只读工具与状态类工具放行，写工具与副作用未知工具拒绝", () => {
    expect(readOnlyToolViolation("write", false)).toBeDefined();
    expect(readOnlyToolViolation("edit", false)).toBeDefined();
    expect(readOnlyToolViolation("read", true)).toBeUndefined();
    expect(readOnlyToolViolation("grep", true)).toBeUndefined();
    // 状态类工具（协作调度与会话内任务管理）无文件写副作用，显式放行
    expect(readOnlyToolViolation("spawn_agent", false)).toBeUndefined();
    expect(readOnlyToolViolation("todo", false)).toBeUndefined();
    expect(readOnlyToolViolation("bash_task", false)).toBeUndefined();
    // 外部工具（MCP）isReadOnly 恒 false：一律拦，方向安全
    expect(readOnlyToolViolation("mcp__server__tool", false)).toMatch(/写副作用/);
    // 元数据缺失按副作用未知拦
    expect(readOnlyToolViolation("unknown_tool", undefined)).toMatch(/副作用未知/);
  });

  it("bash 重定向写文件拒绝（> >> 2> &>），丢弃输出（/dev/null）不拦", () => {
    expect(readOnlyWrite("echo hi > out.txt")).toMatch(/重定向/);
    expect(readOnlyWrite("echo hi >> out.txt")).toMatch(/重定向/);
    expect(readOnlyWrite("ls foo 2> err.log")).toMatch(/重定向/);
    expect(readOnlyWrite("cmd &> all.log")).toMatch(/重定向/);
    expect(readOnlyWrite("git show HEAD > patch.diff")).toMatch(/重定向/);
    // 高频安全用法：丢弃 stderr/stdout
    expect(readOnlyWrite("ls foo 2>/dev/null")).toBeUndefined();
    expect(readOnlyWrite("cmd >/dev/null 2>&1")).toBeUndefined();
    expect(readOnlyWrite("grep -rn x src 2>>/dev/null")).toBeUndefined();
    // fd 复制与 heredoc 输入不拦
    expect(readOnlyWrite("ls foo 2>&1")).toBeUndefined();
    expect(readOnlyWrite("cat <<EOF\nhello\nEOF")).toBeUndefined();
  });

  it("bash 写命令黑名单拒绝（含管道右侧、xargs、多段命令与包装前缀）", () => {
    for (const command of [
      "rm -rf build",
      "mv a.txt b.txt",
      "cp a.txt b.txt",
      "mkdir newdir",
      "touch newfile",
      "chmod +x run.sh",
      "dd if=a of=b",
      "echo hi | tee out.txt",
      "sed -i 's/a/b/' file.txt",
      "sed --in-place s/a/b/ file.txt",
      "find . -name '*.ts' -delete",
      "find . -name '*.ts' -exec rm {} \\;",
      "git add .",
      "git commit -m x",
      "git push",
      "git reset --hard HEAD~1",
      "git checkout main",
      "git switch main",
      "git stash",
      "git branch -d feature",
      "git branch feature",
      "git tag v1.0",
      "git tag -a v1 -m x",
      "git worktree add ../wt main",
      "git worktree remove ../wt",
      "ls && rm x",
      "echo ok; touch f",
      "FOO=1 rm x",
      "sudo rm x",
      "sudo -u root rm x",
      "env -i rm x",
      "timeout 10 rm x",
      "nice -n 5 rm x",
      "sh -c 'rm x'",
      "bash -c \"rm x\"",
      "find . -name '*.ts' | xargs rm",
    ]) {
      expect(readOnlyWrite(command), command).toBeDefined();
    }
  });

  it("只读命令与查询形态放行", () => {
    for (const command of [
      "git show HEAD",
      "git log --oneline -5",
      "git diff HEAD~1",
      "git status",
      "git branch",
      "git branch -a",
      "git branch -v",
      "git branch --contains HEAD",
      "git branch --list dev",
      "git branch --show-current",
      "git tag",
      "git tag -l v1.0",
      "git tag --contains abc",
      "git stash list",
      "git stash show",
      "git worktree list",
      "grep -rn TODO src",
      "ls -la",
      "cat package.json",
      "wc -l src/*.ts",
      "node -e 'console.log(1)'",
      "command -v git",
      "sudo -u root git log --oneline", // 剥包装后是查询命令
    ]) {
      expect(readOnlyWrite(command), command).toBeUndefined();
    }
  });

  it("引号内字面文本不误拦", () => {
    expect(readOnlyWrite('grep "rm -rf" file.txt')).toBeUndefined();
    expect(readOnlyWrite('echo "a > b"')).toBeUndefined();
    expect(readOnlyWrite("echo 'git commit' --dry-run")).toBeUndefined();
  });

  it("已知边界：一行流脚本引号内的写行为不检测（记录口径，非期望行为）", () => {
    // awk/python -c 引号内是会被执行的真实代码，但与字面文本无法区分——
    // 轻量守卫不解析脚本，注释边界如实钉住当前行为
    expect(readOnlyWrite("awk '{print $1 > \"out.txt\"}' f")).toBeUndefined();
  });
});

describe("只读 agent 写拦截判定（Windows 命令语义）", () => {
  it("cmd 与 PowerShell 写命令词拒绝，大小写不敏感（含管道、多段与包装前缀组合）", () => {
    for (const command of [
      "del build.log",
      "DEL build.log",
      "erase build.log",
      "copy a.txt b.txt",
      "Copy a.txt b.txt",
      "xcopy /e src dst",
      "robocopy src dst /mir",
      "move a.txt b.txt",
      "ren a.txt b.txt",
      "rename a.txt b.txt",
      "rd /s /q build",
      "md newdir",
      "mklink link target",
      "format q:",
      "takeown /f file.txt",
      "Remove-Item foo.txt",
      "remove-item foo.txt",
      "ri foo.txt",
      "Copy-Item a.txt b.txt",
      "cpi a.txt b.txt",
      "Move-Item a.txt b.txt",
      "mi a.txt b.txt",
      "New-Item newfile.txt",
      "ni newfile.txt",
      "Set-Content f.txt hello",
      "add-content f.txt more",
      "ac f.txt more",
      "Out-File f.txt",
      "Clear-Content f.txt",
      "clc f.txt",
      "set-itemproperty item prop value",
      "sp item prop value",
      "export-csv out.csv -InputObject x",
      "export-clixml out.xml",
      "set-acl f.txt acl",
      "xcopy.exe /e src dst",
      "dir & del x",
      "echo hi | Out-File out.txt",
      "type a.txt 2>nul & del b.txt",
      "sudo del x",
      "sudo.exe del x",
      "FOO=1 del x",
      "timeout 10 del x",
      "call del x",
      "type a | findstr x & rd /s /q build",
    ]) {
      expect(readOnlyWriteShell(command, "cmd"), command).toBeDefined();
    }
  });

  it("cmd /c /k 转交与 PowerShell 调用整体拒绝（内层命令无法核验），裸 cmd 放行", () => {
    expect(readOnlyWriteShell('powershell -Command "Remove-Item x"', "cmd")).toMatch(/powershell/);
    expect(readOnlyWriteShell("pwsh -c Get-Content f", "cmd")).toMatch(/pwsh/);
    expect(readOnlyWriteShell("powershell -EncodedCommand SQBFAFgA", "cmd")).toMatch(/powershell/);
    expect(readOnlyWriteShell("cmd /c del x", "cmd")).toMatch(/cmd/);
    expect(readOnlyWriteShell("cmd /C del x", "cmd")).toMatch(/cmd/);
    expect(readOnlyWriteShell("cmd /k del x", "cmd")).toMatch(/cmd/);
    expect(readOnlyWriteShell("sudo cmd /c del x", "cmd")).toMatch(/cmd/);
    // 拼写变体不绕过：Windows 可执行名查找不分大小写与分隔符
    expect(readOnlyWriteShell("cmd.exe /c del x", "cmd")).toMatch(/cmd/);
    expect(readOnlyWriteShell("C:\\Windows\\System32\\cmd.exe /c del x", "cmd")).toMatch(/cmd/);
    expect(readOnlyWriteShell("powershell.exe -Command \"Remove-Item x\"", "cmd")).toMatch(/powershell/);
    expect(readOnlyWriteShell("PowerShell -command Remove-Item x", "cmd")).toMatch(/powershell/);
    // /c 与命令粘连的形态（cmd /cdel x）同样命中
    expect(readOnlyWriteShell("cmd /cdel x", "cmd")).toMatch(/cmd/);
    // WSL 与 start 拉起的内层命令同样无法核验
    expect(readOnlyWriteShell("wsl rm -rf /", "cmd")).toMatch(/wsl/);
    expect(readOnlyWriteShell("wsl.exe bash -c \"rm x\"", "cmd")).toMatch(/wsl/);
    expect(readOnlyWriteShell("start del x", "cmd")).toMatch(/start/);
    expect(readOnlyWriteShell("start cmd /c del x", "cmd")).toMatch(/start/);
    // Git Bash 的 sh.exe -c 同样命中
    expect(readOnlyWriteShell("sh.exe -c \"rm x\"", "cmd")).toMatch(/sh -c/);
    expect(readOnlyWriteShell("cmd /d dir", "cmd")).toBeUndefined();
  });

  it("attrib 与 icacls 显示形态放行，修改旗标拒绝", () => {
    expect(readOnlyWriteShell("attrib +r file.txt", "cmd")).toMatch(/attrib/);
    expect(readOnlyWriteShell("attrib -h file.txt", "cmd")).toMatch(/attrib/);
    expect(readOnlyWriteShell("ATTRIB +R file.txt", "cmd")).toMatch(/attrib/);
    expect(readOnlyWriteShell("attrib file.txt", "cmd")).toBeUndefined();
    expect(readOnlyWriteShell("attrib /s /d *.*", "cmd")).toBeUndefined();
    expect(readOnlyWriteShell("icacls file.txt /grant Users:F", "cmd")).toMatch(/icacls/);
    expect(readOnlyWriteShell("icacls file.txt /reset", "cmd")).toMatch(/icacls/);
    expect(readOnlyWriteShell("icacls f /save out.txt", "cmd")).toMatch(/icacls/);
    expect(readOnlyWriteShell("icacls f /restore saved.txt", "cmd")).toMatch(/icacls/);
    expect(readOnlyWriteShell("icacls f /setowner Administrators", "cmd")).toMatch(/icacls/);
    expect(readOnlyWriteShell("icacls f /substitute old new", "cmd")).toMatch(/icacls/);
    expect(readOnlyWriteShell("icacls file.txt", "cmd")).toBeUndefined();
    // sc 跨 shell 二义（PS 的 Set-Content 别名与 cmd 的服务控制），不入黑名单，查询放行
    expect(readOnlyWriteShell("sc query wuauserv", "cmd")).toBeUndefined();
  });

  it("空设备重定向不误拦：cmd/PowerShell 的 nul 豁免，bash 语义下 nul 是普通文件", () => {
    // E172 实测误拦场景：只读审查子 agent 的复合命令
    expect(readOnlyWriteShell("type vitest.config.ts 2>nul & dir /b src", "cmd")).toBeUndefined();
    expect(readOnlyWriteShell("type vitest.config.ts 2>NUL", "cmd")).toBeUndefined();
    expect(readOnlyWriteShell("dir /b src >nul", "cmd")).toBeUndefined();
    expect(readOnlyWriteShell("type a.txt 2>>nul", "powershell")).toBeUndefined();
    // 带扩展名的 nul 在 NT 上是普通文件，不豁免
    expect(readOnlyWriteShell("type a.txt 2>nul.txt", "cmd")).toMatch(/重定向/);
    // bash 语义下 nul 是普通文件名，重定向即写
    expect(readOnlyWriteShell("type a.txt 2>nul", "bash")).toMatch(/重定向/);
  });

  it("只读命令与查询形态在 cmd 语义下放行（type/where/dir 不入黑名单）", () => {
    for (const command of [
      "type vitest.config.ts",
      "type a.txt | findstr pattern",
      "where git",
      "dir /b src",
      "attrib file.txt",
      "icacls file.txt",
    ]) {
      expect(readOnlyWriteShell(command, "cmd"), command).toBeUndefined();
    }
  });

  it("命令词大小写不敏感匹配（Windows 可执行名查找不分大小写）", () => {
    expect(readOnlyWriteShell("RM -rf build", "bash")).toMatch(/写命令/);
    expect(readOnlyWriteShell("Rm x", "cmd")).toMatch(/写命令/);
    expect(readOnlyWriteShell("XARGS RM", "bash")).toMatch(/写命令/);
  });
});

/** bash 判定捷径（只读元数据 + bash 命令 + 指定 shell 语义） */
function readOnlyWriteShell(command: string, shell: CommandShellKind): string | undefined {
  return readOnlyToolViolation("bash", false, command, shell);
}

/** bash 判定捷径（只读元数据 + bash 命令） */
function readOnlyWrite(command: string): string | undefined {
  return readOnlyToolViolation("bash", false, command);
}
