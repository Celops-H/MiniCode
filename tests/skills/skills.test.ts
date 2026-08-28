import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSkillsPromptSection,
  createSkillTool,
  parseFrontmatter,
  scanSkills,
} from "../../src/skills/index.js";

describe("parseFrontmatter（frontmatter 两行子集解析）", () => {
  it("解析 name/description 并剥出正文", () => {
    const { attrs, body } = parseFrontmatter("---\nname: my-skill\ndescription: 干什么用的\n---\n正文第一行\n\n正文第二行");
    expect(attrs).toEqual({ name: "my-skill", description: "干什么用的" });
    expect(body).toBe("正文第一行\n\n正文第二行");
  });

  it("CRLF 归一后同样解析", () => {
    const { attrs } = parseFrontmatter("---\r\nname: a\r\ndescription: b\r\n---\r\nbody");
    expect(attrs).toEqual({ name: "a", description: "b" });
    expect(parseFrontmatter("---\r\nname: a\r\ndescription: b\r\n---\r\nbody").body).toBe("body");
  });

  it("空 frontmatter（---\\n---）解析为空属性、正文取其后", () => {
    const { attrs, body } = parseFrontmatter("---\n---\nbody here");
    expect(attrs).toEqual({});
    expect(body).toBe("body here");
  });

  it("无 frontmatter 与有头无尾都整体当正文", () => {
    expect(parseFrontmatter("直接正文").body).toBe("直接正文");
    expect(parseFrontmatter("---\nname: a\n没有收尾").attrs).toEqual({});
    expect(parseFrontmatter("---\nname: a\n没有收尾").body).toBe("---\nname: a\n没有收尾");
  });

  it("收尾分隔线是文件最后一行（无换行）时正文为空", () => {
    const { attrs, body } = parseFrontmatter("---\nname: a\n---");
    expect(attrs).toEqual({ name: "a" });
    expect(body).toBe("");
  });

  it("未知键忽略；键值两侧空白剥离", () => {
    const { attrs } = parseFrontmatter("---\nname: a\nversion: 2\n  description :  带空格  \n---\nb");
    expect(attrs).toEqual({ name: "a", version: "2", description: "带空格" });
  });
});

describe("scanSkills（目录扫描）", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 造技能目录：skills 根目录 + 子目录 SKILL.md */
  function makeSkillDir(root: string, name: string, content: string): string {
    mkdirSync(path.join(root, name), { recursive: true });
    writeFileSync(path.join(root, name, "SKILL.md"), content);
    return root;
  }

  function setup(): string {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-skills-"));
    return tmpDir;
  }

  it("扫描项目与用户目录，同名技能项目覆盖用户", async () => {
    const root = setup();
    makeSkillDir(path.join(root, "user-skills"), "review", "---\nname: review\ndescription: 用户版审查\n---\n用户正文");
    makeSkillDir(path.join(root, "user-skills"), "deploy", "---\nname: deploy\ndescription: 部署\n---\n部署正文");
    makeSkillDir(path.join(root, "proj-skills"), "review", "---\nname: review\ndescription: 项目版审查\n---\n项目正文");

    const skills = await scanSkills({
      projectDir: path.join(root, "proj-skills"),
      userDir: path.join(root, "user-skills"),
    });
    expect(skills).toHaveLength(2);
    const review = skills.find((s) => s.name === "review");
    expect(review).toMatchObject({ description: "项目版审查", source: "project" });
    expect(skills.find((s) => s.name === "deploy")?.source).toBe("user");
  });

  it("name 缺省取目录名、description 缺省取正文首个非空行", async () => {
    const root = setup();
    makeSkillDir(path.join(root, "proj-skills"), "no-fm", "第一行是描述\n\n# 标题\n正文");

    const skills = await scanSkills({ projectDir: path.join(root, "proj-skills"), userDir: path.join(root, "none") });
    expect(skills).toEqual([
      { name: "no-fm", description: "第一行是描述", source: "project", filePath: path.join(root, "proj-skills", "no-fm", "SKILL.md") },
    ]);
  });

  it("disabled 名单过滤命中技能", async () => {
    const root = setup();
    makeSkillDir(path.join(root, "proj-skills"), "a", "---\nname: a\ndescription: A\n---\nA");
    makeSkillDir(path.join(root, "proj-skills"), "b", "---\nname: b\ndescription: B\n---\nB");

    const skills = await scanSkills({
      projectDir: path.join(root, "proj-skills"),
      userDir: path.join(root, "none"),
      disabled: ["a"],
    });
    expect(skills.map((s) => s.name)).toEqual(["b"]);
  });

  it("目录不存在返回空；非目录项与缺 SKILL.md 的子目录跳过", async () => {
    const root = setup();
    writeFileSync(path.join(root, "not-a-dir.txt"), "文件不是技能");
    mkdirSync(path.join(root, "empty-skill"));
    expect(await scanSkills({ projectDir: root, userDir: path.join(root, "none") })).toEqual([]);
    expect(await scanSkills({ projectDir: path.join(root, "missing"), userDir: path.join(root, "none") })).toEqual([]);
  });
});

describe("buildSkillsPromptSection / createSkillTool", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("提示词段逐条列出 name — description 并给取用方式", () => {
    const section = buildSkillsPromptSection([
      { name: "a", description: "A 技能", source: "project", filePath: "/x/a/SKILL.md" },
      { name: "b", description: "B 技能", source: "user", filePath: "/x/b/SKILL.md" },
    ]);
    expect(section).toContain("【可用技能】");
    expect(section).toContain("skill 工具");
    expect(section).toContain("- a — A 技能");
    expect(section).toContain("- b — B 技能");
  });

  it("skill 工具返回正文（不含 frontmatter）；未知技能报失败", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "minicode-skills-"));
    const dir = path.join(tmpDir, "proj-skills");
    mkdirSync(path.join(dir, "review"), { recursive: true });
    const file = path.join(dir, "review", "SKILL.md");
    writeFileSync(file, "---\nname: review\ndescription: 审查\n---\n审查指令正文\n步骤 2");

    const tool = createSkillTool([
      { name: "review", description: "审查", source: "project", filePath: file },
    ]);
    expect(tool.isReadOnly).toBe(true);
    // 成功路径返回纯文本正文（ExecuteResult string 形态）
    expect(await tool.execute({ name: "review" })).toBe("审查指令正文\n步骤 2");

    const bad = await (tool.execute({ name: "nope" }) as Promise<{ output: string; isError?: boolean }>);
    expect(bad.isError).toBe(true);
    expect(bad.output).toContain("未知技能：nope");
    expect(bad.output).toContain("review");
  });
});
