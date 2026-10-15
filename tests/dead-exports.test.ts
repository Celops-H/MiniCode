/**
 * 死导出守卫：全库（含测试）无引用的导出已收为模块内部使用。
 * 用例按模块命名空间断言这些标识符不再出现在对外接口上，防后续改动误加回 export。
 * 每条另断言一个仍在导出的标识符（哨兵）在命名空间内，模块解析异常时防空集假通过。
 */
import { describe, expect, it } from "vitest";
import * as configPaths from "../src/config/paths.js";
import * as configTypes from "../src/config/types.js";
import * as staleBuild from "../src/bootstrap/staleBuild.js";

/** [模块相对路径, 模块命名空间, 仍在导出的标识符（哨兵）, 不应再导出的标识符] */
const CASES: Array<[string, object, string, string[]]> = [
  ["config/paths.ts", configPaths, "resolveTracesDir", ["sanitizePath"]],
  [
    "config/types.ts",
    configTypes,
    "configSchema",
    [
      "PROVIDER_PROTOCOLS",
      "modelConfigSchema",
      "providerConfigSchema",
      "mcpServerConfigSchema",
      "skillsConfigSchema",
      "debugConfigSchema",
      "observabilityConfigSchema",
    ],
  ],
  ["bootstrap/staleBuild.ts", staleBuild, "isStaleBuild", ["runBuild", "lastCommitTime"]],
];

describe("死导出守卫：无引用导出已降为非导出", () => {
  for (const [file, ns, canary, symbols] of CASES) {
    it(`${file} 不导出 ${symbols.join(" / ")}`, () => {
      const keys = Object.keys(ns);
      expect(keys).toContain(canary);
      for (const symbol of symbols) expect(keys).not.toContain(symbol);
    });
  }
});
