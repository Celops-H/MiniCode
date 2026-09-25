/**
 * 分层守卫：src/tui 之外的源码不得引用 src/tui（静态 from 导入、动态 import()、副作用 import 三形态全扫）。
 * tsc 构建排除 src/tui（TUI 由 vite 单独打包成 dist/tui/index.js），下层模块一旦反向依赖，
 * dist 里就没有对应文件，运行时即报 Cannot find module；而 typecheck 用全量 tsconfig 测不出。
 * 例外见 ALLOWED：src/cli/app.ts 懒加载 TUI 入口 ../tui/index.js，该文件是 vite 产物，dist 存在。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** 允许的例外：文件相对 src 的路径（正斜杠）+ 引用的模块说明符 */
const ALLOWED = new Set(["cli/app.ts:../tui/index.js"]);

/** 递归收集目录下全部 .ts/.tsx 源文件（跳过 .d.ts 与 src/tui 自身） */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (path.relative(srcDir, full) === "tui") continue;
      out.push(...collectFiles(full));
    } else if ((name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** 捕获组取模块说明符；尾斜杠可选，兼容 from "../tui" 引目录的写法 */
const PATTERNS = [
  /from\s*["']((?:\.\.?\/)+(?:[\w.-]+\/)*tui(?:\/[^"']*)?)["']/g,
  /import\s*\(\s*["']((?:\.\.?\/)+(?:[\w.-]+\/)*tui(?:\/[^"']*)?)["']/g,
  /^\s*import\s+["']((?:\.\.?\/)+(?:[\w.-]+\/)*tui(?:\/[^"']*)?)["']/gm,
];

describe("分层守卫：src/tui 之外的源码不得引用 src/tui", () => {
  it("无下层模块反向依赖渲染层（例外见 ALLOWED）", () => {
    const offenders: string[] = [];
    for (const file of collectFiles(srcDir)) {
      const rel = path.relative(srcDir, file).split(path.sep).join("/");
      const content = readFileSync(file, "utf8");
      for (const pattern of PATTERNS) {
        for (const match of content.matchAll(pattern)) {
          const entry = `${rel}:${match[1]}`;
          if (!ALLOWED.has(entry)) offenders.push(entry);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
