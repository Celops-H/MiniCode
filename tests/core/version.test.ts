/**
 * 版本号单一出处守卫：代码里的常量与 package.json 的 version 必须一致，
 * 防止两处各改一半，命令行报一个版本、打包元数据是另一个。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MINICODE_VERSION } from "../../src/core/index.js";

describe("MINICODE_VERSION（项目版本号单一出处）", () => {
  it("与 package.json 的 version 一致", () => {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(MINICODE_VERSION).toBe(pkg.version);
  });
});
