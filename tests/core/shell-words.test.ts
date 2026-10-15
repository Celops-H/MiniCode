import { describe, expect, it } from "vitest";
import { normalizeCommandWord, stripCommandPrefix, uniqWritesToFile } from "../../src/core/index.js";

describe("normalizeCommandWord（命令词归一）", () => {
  it("取路径基名、剥可执行后缀与分组符号、转小写", () => {
    expect(normalizeCommandWord("ls")).toBe("ls");
    expect(normalizeCommandWord("/usr/bin/ls")).toBe("ls");
    expect(normalizeCommandWord("C:\\Windows\\System32\\CMD.EXE")).toBe("cmd");
    expect(normalizeCommandWord("del.exe")).toBe("del");
    expect(normalizeCommandWord("REMOVE-ITEM")).toBe("remove-item");
    // 括号与 @ 前缀是常见拼写形态
    expect(normalizeCommandWord("(rm")).toBe("rm");
    expect(normalizeCommandWord("@del")).toBe("del");
  });
});

describe("stripCommandPrefix（段首包装剥离）", () => {
  it("剥开包装命令与分组符号词，露出真实命令词", () => {
    expect(stripCommandPrefix(["rm", "x"])).toEqual({ rest: ["rm", "x"], queried: false });
    expect(stripCommandPrefix(["sudo", "rm", "x"])).toEqual({ rest: ["rm", "x"], queried: false });
    expect(stripCommandPrefix(["env", "FOO=1", "rm", "x"])).toEqual({ rest: ["rm", "x"], queried: false });
    expect(stripCommandPrefix(["(", "rm", "x"])).toEqual({ rest: ["rm", "x"], queried: false });
  });

  it("取值选项连其参数一并剥掉，无参旗标不吞后继命令词", () => {
    // stdbuf 的 -o 带参数，连同 "L" 一起剥掉
    expect(stripCommandPrefix(["stdbuf", "-o", "L", "rm", "x"])).toEqual({ rest: ["rm", "x"], queried: false });
    // env -i 是无参旗标，不吃后继的 rm
    expect(stripCommandPrefix(["env", "-i", "rm", "x"])).toEqual({ rest: ["rm", "x"], queried: false });
    // timeout 的时长排在选项之后
    expect(stripCommandPrefix(["timeout", "-k", "5", "10", "rm", "x"])).toEqual({ rest: ["rm", "x"], queried: false });
  });

  it("command -v/-V 是查询形态，按 queried 标记返回", () => {
    expect(stripCommandPrefix(["command", "-v", "rm"]).queried).toBe(true);
    expect(stripCommandPrefix(["command", "-pV", "rm"]).queried).toBe(true);
    // command 只带 -p 时剥掉 command 与其旗标，后续命令词照常判定
    expect(stripCommandPrefix(["command", "-p", "rm", "x"])).toEqual({ rest: ["rm", "x"], queried: false });
  });
});

describe("uniqWritesToFile（uniq 输出位落盘判定）", () => {
  it("第二操作数是文件即落盘，输出位是 -（stdout）或无输出位不落盘", () => {
    expect(uniqWritesToFile(["in.txt", "out.txt"])).toBe(true);
    expect(uniqWritesToFile(["-", "out.txt"])).toBe(true);
    expect(uniqWritesToFile(["in.txt", "-"])).toBe(false);
    expect(uniqWritesToFile(["in.txt"])).toBe(false);
    expect(uniqWritesToFile([])).toBe(false);
  });

  it("取值旗标连其参数一并跳过，-- 之后的词全按操作数算", () => {
    expect(uniqWritesToFile(["-f", "1", "in.txt", "out.txt"])).toBe(true);
    expect(uniqWritesToFile(["-f", "2", "report.txt"])).toBe(false);
    expect(uniqWritesToFile(["--", "-weird.txt", "out.txt"])).toBe(true);
  });
});
