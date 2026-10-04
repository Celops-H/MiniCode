import { describe, expect, it } from "vitest";
import { readOnlyToolViolation } from "../../src/permission/index.js";

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

/** bash 判定捷径（只读元数据 + bash 命令） */
function readOnlyWrite(command: string): string | undefined {
  return readOnlyToolViolation("bash", false, command);
}
