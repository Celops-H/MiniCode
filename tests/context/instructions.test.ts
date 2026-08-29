import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInitPrompt, buildInstructionsPrompt, loadInstructionFiles, readInstructionFile } from "../../src/context/instructions.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "minicode-instr-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("loadInstructionFiles（指令文件加载）", () => {
  it("加载用户级 ~/.minicode/AGENTS.md 一份", async () => {
    const home = tempDir();
    mkdirSync(path.join(home, ".minicode"));
    writeFileSync(path.join(home, ".minicode", "AGENTS.md"), "用户级指令");
    const files = await loadInstructionFiles({ homedir: home, cwd: tempDir() });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ content: "用户级指令" });
    expect(files[0]!.path).toContain(path.join(".minicode", "AGENTS.md"));
  });

  it("项目级：cwd 有指令文件就用它，不向上加载祖先目录的（E37 当前目录有即停）", async () => {
    const home = tempDir();
    const root = tempDir();
    const cwd = path.join(root, "proj");
    mkdirSync(cwd);
    writeFileSync(path.join(root, "AGENTS.md"), "根级指令");
    writeFileSync(path.join(cwd, "AGENTS.md"), "cwd 级指令");
    const files = await loadInstructionFiles({ homedir: home, cwd });
    // 只有 cwd 一份：祖先目录（项目外越界面）的指令文件不再收集
    expect(files.map((f) => f.content)).toEqual(["cwd 级指令"]);
  });

  it("项目级：cwd 没有才逐级向上，找到最近的一个即停（E37 越界加载根因修复）", async () => {
    const home = tempDir();
    const root = tempDir();
    const mid = path.join(root, "a");
    const cwd = path.join(mid, "b");
    mkdirSync(mid, { recursive: true });
    mkdirSync(cwd);
    writeFileSync(path.join(root, "AGENTS.md"), "根级指令");
    writeFileSync(path.join(mid, "AGENTS.md"), "mid 级指令");
    const files = await loadInstructionFiles({ homedir: home, cwd });
    // 命中 mid 即停：更远的根级文件不加载（此前根→cwd 全层级收集会越界拼入无关约定）
    expect(files.map((f) => f.content)).toEqual(["mid 级指令"]);
  });

  it("命中级内 AGENTS.md 优先、没有才读 CLAUDE.md 兜底（同级不重复注入）", async () => {
    const home = tempDir();
    const root = tempDir();
    const cwd = path.join(root, "proj");
    mkdirSync(cwd);
    writeFileSync(path.join(cwd, "AGENTS.md"), "cwd AGENTS");
    writeFileSync(path.join(cwd, "CLAUDE.md"), "cwd CLAUDE");
    const files = await loadInstructionFiles({ homedir: home, cwd });
    expect(files.map((f) => f.content)).toEqual(["cwd AGENTS"]);
  });

  it("无任何文件时返回空数组（静默无此段）", async () => {
    const files = await loadInstructionFiles({ homedir: tempDir(), cwd: tempDir() });
    expect(files).toEqual([]);
  });
});

describe("buildInstructionsPrompt（指令段拼接）", () => {
  it("空列表返回空串", () => {
    expect(buildInstructionsPrompt([])).toBe("");
  });

  it("多文件以段标题开头、内容空行分隔", () => {
    const prompt = buildInstructionsPrompt([
      { path: "/r/AGENTS.md", content: "外层" },
      { path: "/r/p/CLAUDE.md", content: "内层" },
    ]);
    expect(prompt).toContain("【项目指令】");
    expect(prompt.indexOf("外层")).toBeLessThan(prompt.indexOf("内层"));
  });
});

describe("buildInitPrompt（/init 提示词）", () => {
  it("无文件时要求新建并写入项目根 AGENTS.md", () => {
    const prompt = buildInitPrompt(null);
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("不要凭记忆编造");
    expect(prompt).toContain("write 工具");
  });

  it("已存在时要求不覆盖、先建议改进，并附上现有内容", () => {
    const prompt = buildInitPrompt("已有指令内容");
    expect(prompt).toContain("不覆盖");
    expect(prompt).toContain("改进");
    expect(prompt).toContain("已有指令内容");
  });
});

describe("readInstructionFile（读指令文件）", () => {
  it("文件不存在返回 null，其余错误原样上抛", async () => {
    expect(await readInstructionFile(path.join(tempDir(), "无.md"))).toBeNull();
  });
});
