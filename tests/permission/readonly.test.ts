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
      "sed -i.bak s/a/b/ f.txt",
      "sed --in-place=.bak s/a/b/ f.txt",
      "sed -ni 'p' f.txt",
      "sed -Ei 's/a/b/' f.txt",
      "sed -I.bak 's/a/b/' f.txt",
      "sed -I .bak 's/a/b/' f.txt",
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
    // Git Bash 的 sh.exe -c 同样命中（shell 执行体整体拒绝，见脚本执行形态用例）
    expect(readOnlyWriteShell("sh.exe -c \"rm x\"", "cmd")).toMatch(/sh（脚本执行无法核验）/);
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

describe("只读 agent 写拦截判定（脚本执行形态）", () => {
  it("shell 家族与 Windows 脚本宿主整体拒绝：-c、脚本文件与 stdin 同口径", () => {
    for (const command of [
      "sh x.sh",
      "bash x.sh",
      "bash -x setup.sh",
      "dash run.sh",
      "zsh run.sh",
      "ksh run.sh",
      "fish run.fish",
      "bash",
      "bash --version",
      "sh < input.sh",
      "cscript setup.vbs",
      "wscript run.js",
      "cscript //nologo x.vbs",
      "sudo bash x.sh",
      "timeout 10 sh build.sh",
    ]) {
      expect(readOnlyWrite(command), command).toMatch(/脚本执行无法核验/);
    }
  });

  it("解释器脚本文件执行拒绝（含 -m 模块、stdin 与 xargs 形态），一行流维持放行", () => {
    for (const command of [
      "python x.py",
      "python3 x.py",
      "py x.py",
      "python ./tool.py",
      "python -m json.tool in.json",
      "python -V x.py",
      "python -E tool.py",
      "python -B x.py",
      "python -OO x.py",
      "node x.js",
      "node --experimental-strip-types x.ts",
      "node -r ./pre.js app.js",
      "node --require ./pre.js app.js",
      "perl x.pl",
      "perl -C script.pl",
      "ruby x.rb",
      "ruby -E UTF-8 run.rb",
      "ruby -w script.rb",
      "php x.php",
      "lua x.lua",
      "python -",
      "node -",
      "ls *.py | xargs python",
      "xargs -n1 node",
    ]) {
      expect(readOnlyWrite(command), command).toMatch(/脚本文件执行无法核验|写命令 xargs/);
    }
    for (const command of [
      "node -e 'console.log(1)'",
      "node -p '1+1'",
      "node --eval 'x'",
      "python -c 'print(1)'",
      "python --version",
      "python -c 'import sys; print(sys.argv)' a b",
      "perl -e 'print 1'",
      "perl -E 'print 1'",
      "perl -pe 's/a/b/'",
      "perl -lane 'print $F[0]'",
      "perl -Mstrict -e 'print 1'",
      "perl -MList::Util -e 'x'",
      "ruby -e 'puts 1'",
      "ruby -we 'puts 1'",
      "ruby -Ilib -e 'puts 1'",
      "php -r 'echo 1;'",
      "php -R 'echo 1;'",
      "php -B 'echo 1;'",
      "lua -e 'print(1)'",
    ]) {
      expect(readOnlyWrite(command), command).toBeUndefined();
    }
  });

  it("perl/ruby 的 -i 原地改写拒绝（含组合与后缀形态）", () => {
    for (const command of [
      "perl -i -pe 's/a/b/' f.txt",
      "perl -pi -e 's/a/b/' f.txt",
      "perl -i.bak -pe 's/a/b/' f.txt",
      "ruby -i -pe 'puts 1' f.txt",
    ]) {
      expect(readOnlyWrite(command), command).toMatch(/原地改写/);
    }
    expect(readOnlyWrite("ruby -e 'puts 1'")).toBeUndefined();
  });

  it("awk/sed 的 -f/--file 脚本文件拒绝，内联程序与 -F 字段分隔符放行", () => {
    for (const command of [
      "awk -f prog.awk data.txt",
      "awk --file=prog.awk data.txt",
      "gawk -f p.awk f",
      "mawk -f p.awk f",
      "awk -fprog.awk data.txt",
      "sed -f script.sed input.txt",
      "sed --file=script.sed f",
    ]) {
      expect(readOnlyWrite(command), command).toMatch(/脚本文件执行无法核验/);
    }
    for (const command of [
      "awk '{print $1}' f",
      "awk -F: '{print $1}' f",
      "gawk -F, '{print $2}' f",
      "sed 's/a/b/' f",
      "sed -n '1,5p' f",
      "sed -e 's/a/b/' f",
    ]) {
      expect(readOnlyWrite(command), command).toBeUndefined();
    }
  });
});

describe("只读 agent 写拦截判定（分组符号与 @ 前缀）", () => {
  it("括号/花括号分组与 cmd @ 静默前缀的写命令照常命中", () => {
    for (const command of [
      "(rm x)",
      "( rm x)",
      "(del x)",
      "(rm -rf build)",
      "((rm x))",
      "{ rm x",
      "@del x",
      "@ del x",
      "@rm -rf build",
      "@git commit -m x",
      "timeout 10 @del x",
      "(sudo rm x)",
      "(rm x 2>/dev/null)",
      "(curl -o f.txt http://x)",
    ]) {
      expect(readOnlyWrite(command), command).toBeDefined();
    }
  });

  it("查询形态不误伤（括号包住的只读命令照常放行）", () => {
    for (const command of ["(ls)", "@echo hi", "@echo off", "{ ls", "echo (x)", "git log --oneline", "@where git"]) {
      expect(readOnlyWrite(command), command).toBeUndefined();
    }
  });

  it("包装剥开后的独立符号词照常剥离；command 的 -v/-V 查询放行", () => {
    // call 剥开后段首露出独立符号词（cmd 的 call 会重新解析后续命令行）
    for (const command of ["call ( del x", "call @ del x"]) {
      expect(readOnlyWriteShell(command, "cmd"), command).toBeDefined();
    }
    // command -v/-V 只查询命令路径，不执行后续命令词；旗标可组合、sudo 包装叠加同样放行
    for (const command of [
      "command -v rm",
      "command -V rm",
      "command -pv rm",
      "command -p -v rm",
      "sudo command -v rm",
      "command -v git",
    ]) {
      expect(readOnlyWriteShell(command, "cmd"), command).toBeUndefined();
    }
    // command 不带 -v/-V 时后续命令词照常判定（-p 用默认 PATH 执行后续命令，照拦）
    expect(readOnlyWriteShell("command rm x", "cmd")).toBeDefined();
    expect(readOnlyWriteShell("command -p rm x", "cmd")).toBeDefined();
    expect(readOnlyWriteShell("command -p git log", "cmd")).toBeUndefined();
    // -- 结束选项标记：剥掉后按后续命令词判定（黑名单与形态分支都要走到）；带 -v 时仍是查询
    expect(readOnlyWriteShell("command -- rm x", "cmd")).toBeDefined();
    expect(readOnlyWriteShell("command -p -- rm x", "cmd")).toBeDefined();
    expect(readOnlyWriteShell("command -- git add .", "cmd")).toBeDefined();
    expect(readOnlyWriteShell("command -- curl -o f http://x", "cmd")).toBeDefined();
    expect(readOnlyWriteShell("command -v -- rm", "cmd")).toBeUndefined();
    expect(readOnlyWriteShell("command -p -- git log", "cmd")).toBeUndefined();
  });
});

describe("只读 agent 写拦截判定（落盘与持久化形态）", () => {
  it("下载落盘拒绝：curl 输出旗标、wget 整体、iwr/irm 的 -OutFile；curl 裸用与查询形态放行", () => {
    for (const command of [
      "curl -o f.txt http://x",
      "curl -O http://x",
      "curl -sO http://x",
      "curl -ofile.txt http://x",
      "curl --output f.txt http://x",
      "curl --output=f.txt http://x",
      "curl --remote-name http://x",
      "curl --remote-name-all http://x",
      "curl -D h.txt http://x",
      "curl -c jar.txt http://x",
      "curl -sD h.txt http://x",
      "curl --dump-header h.txt http://x",
      "curl --cookie-jar j.txt http://x",
      "curl --stderr e.log http://x",
      "curl --trace t.log http://x",
      "curl --trace-ascii t.log http://x",
      "curl --etag-save e.txt http://x",
      "curl --libcurl out.c http://x",
      "curl --alt-svc a.txt http://x",
      "curl --hsts h.txt http://x",
      "wget http://x",
      "wget -q https://x",
      "wget.exe -O f.txt http://x",
      "iwr -OutFile f.txt http://x",
      "irm -OutFile f http://x",
      "Invoke-WebRequest -OutFile f http://x",
      "iwr -OutF f.txt http://x",
      "Invoke-WebRequest -OutFi f http://x",
    ]) {
      expect(readOnlyWrite(command), command).toMatch(/落盘写文件|写命令 wget/);
    }
    for (const command of [
      "curl http://x",
      "curl -s https://x/api",
      "curl -I http://x",
      "curl -H 'Accept: x' http://x",
      "curl -b jar.txt http://x",
      "curl -C - http://x",
      "curl -A agent http://x",
      "iwr http://x",
      "irm https://x/api",
    ]) {
      expect(readOnlyWrite(command), command).toBeUndefined();
    }
  });

  it("xargs 后的目标走同一套段判定，落盘与持久化形态不再穿越", () => {
    for (const command of [
      "xargs reg add HKLM /v a /d b",
      "echo x | xargs reg add HKLM",
      "xargs sort -o f",
      "xargs curl -o f http://x",
      "xargs -I {} rm {}",
      "xargs sc start x",
      "xargs schtasks /create /tn t",
      // 取值选项的参数被引号剔除后消失的形态：跳过取值会把真目标词吞掉，靠多线索兜底
      "xargs -I '{}' rm '{}'",
      "xargs -d '\\n' rm x",
      "xargs -E '' rm x",
      "xargs --process-slot-var VAR rm x",
      // 多个取值选项叠加、词序按消失的值前移的形态
      "xargs -P 4 -d '\\n' rm",
      "xargs -d '\\n' -n 1 rm x",
      "xargs -I '{}' -P 4 rm -rf '{}'",
      "xargs -P 4 -I '{}' rm -rf '{}'",
      "xargs -n 2 rm",
    ]) {
      expect(readOnlyWriteShell(command, "cmd"), command).toBeDefined();
    }
    for (const command of [
      "xargs grep foo",
      "xargs -n 2 echo",
      "xargs -n1 echo",
      "xargs -I {} echo {}",
      // 取值选项后的实参不是目标：grep 是目标、rm 是模式，不因取值链误拦
      "xargs -n 2 grep rm f",
      "xargs -a list.txt grep rm f",
    ]) {
      expect(readOnlyWriteShell(command, "cmd"), command).toBeUndefined();
    }
  });

  it("sort 输出写文件拒绝（cmd /o 与 POSIX -o/--output），无输出选项放行", () => {
    for (const command of [
      "sort /o out.txt in.txt",
      "sort /O out.txt",
      "sort -o out.txt in.txt",
      "sort --output=out.txt in.txt",
    ]) {
      expect(readOnlyWrite(command), command).toMatch(/输出写文件/);
    }
    for (const command of ["sort in.txt", "sort -n in.txt", "sort -r -k2 f", "sort /R f"]) {
      expect(readOnlyWrite(command), command).toBeUndefined();
    }
  });

  it("注册表、计划任务、环境变量持久化写拒绝，查询形态放行", () => {
    for (const command of [
      "reg add HKLM /v a /d b",
      "REG ADD HKLM /v a /d b",
      "reg delete HKLM /f",
      "reg save HKLM f.hiv",
      "reg restore HKLM f.hiv",
      "reg export HKLM f.reg",
      "reg import f.reg",
      "setx FOO bar",
      "SETX FOO bar",
      "schtasks /create /tn t /tr x",
      "schtasks /delete /tn t /f",
      "schtasks /change /tn t /tr y",
      "schtasks /run /tn t",
      "schtasks /end /tn t",
      "schtasks /CREATE /tn t",
    ]) {
      expect(readOnlyWrite(command), command).toBeDefined();
    }
    for (const command of [
      "reg query HKLM",
      "reg query HKLM /v a",
      "reg compare HKLM HKLM2",
      "schtasks /query /tn t",
      "schtasks /query /v /fo list",
    ]) {
      expect(readOnlyWrite(command), command).toBeUndefined();
    }
  });

  it("sc 跨 shell 二义：PowerShell 裸 sc 按 Set-Content 拒绝，sc.exe 与 cmd 读子命令放行", () => {
    // PS 5.1 语义：裸 sc 是 Set-Content 别名，任何用法按写拒绝；显式 sc.exe 拼写按服务控制判
    expect(readOnlyWriteShell("sc query wuauserv", "powershell")).toMatch(/Set-Content/);
    expect(readOnlyWriteShell("sc f.txt hello", "powershell")).toMatch(/Set-Content/);
    expect(readOnlyWriteShell("sc.exe query wuauserv", "powershell")).toBeUndefined();
    // cmd/bash 语义：sc.exe 服务控制，读子命令白名单放行、其余按写拒绝
    for (const command of [
      "sc start wuauserv",
      "sc stop wuauserv",
      "sc config x binPath= y",
      "sc create x binPath= y",
      "sc delete x",
      "sc sdset s d",
      "sc failure x reset= 0",
    ]) {
      expect(readOnlyWriteShell(command, "cmd"), command).toMatch(/服务控制写操作/);
    }
    for (const command of [
      "sc query wuauserv",
      "sc queryex Spooler",
      "sc qc Spooler",
      "sc qdescription Spooler",
      "sc qfailure Spooler",
      "sc qfailureflag Spooler",
      "sc qsidtype Spooler",
      "sc qprivs Spooler",
      "sc qtriggerinfo Spooler",
      "sc qpreferrednode Spooler",
      "sc qmanagedaccount Spooler",
      "sc qprotection Spooler",
      "sc quserservice Spooler",
      "sc interrogate Spooler",
      "sc enumdepend Spooler",
      "sc sdshow Spooler",
      "sc getdisplayname Spooler",
      "sc getkeyname Spooler",
      "sc /?",
      "sc",
    ]) {
      expect(readOnlyWriteShell(command, "cmd"), command).toBeUndefined();
    }
    // 子命令前的 \\server 形态（sc \\srv query svc）：读子命令放行、写子命令照拦
    expect(readOnlyWriteShell("sc \\\\srv query wuauserv", "cmd")).toBeUndefined();
    expect(readOnlyWriteShell("sc \\\\srv qc Spooler", "cmd")).toBeUndefined();
    expect(readOnlyWriteShell("sc \\\\srv start wuauserv", "cmd")).toMatch(/服务控制写操作/);
    // PS 语义下显式 sc.exe 拼写按服务控制判：写子命令照拦
    expect(readOnlyWriteShell("sc.exe create x binPath= y", "powershell")).toMatch(/服务控制写操作/);
    // Windows Git Bash 下 sc 经 sc.exe 解析，同 cmd 口径
    expect(readOnlyWriteShell("sc query wuauserv", "bash")).toBeUndefined();
    expect(readOnlyWriteShell("sc start wuauserv", "bash")).toMatch(/服务控制写操作/);
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
