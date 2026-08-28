import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PROVIDER_PRESETS } from "./presets.js";
import { resolveConfigPaths, type ConfigPaths } from "./paths.js";

/**
 * 全局配置播种（BACKEND §14）：CLI/TUI 任一入口装配配置前调用。
 * ~/.minicode/config.json 不存在则递归建目录写入种子（只写 providers，其余字段靠
 * schema 默认值）；文件存在则一个字节不动——用户手编内容绝对尊重。删除文件后重启
 * 按预设重建，这是重置出口，也顺带解决版本升级新预设的获取（升级不回填：无法区分
 * 「用户故意删」和「未生成」）。
 *
 * 写入用 wx 独占标志防并发双写：CLI/TUI 同时首启只落一份，独占冲突（EEXIST）静默
 * 放行——文件已在，内容必是种子或用户手编，两种情况都不该再动。
 * @param paths 配置路径（测试可注入；缺省按真实用户目录解析）
 */
export async function ensureGlobalConfigSeed(paths?: ConfigPaths): Promise<void> {
  const file = paths?.globalConfigFile ?? resolveConfigPaths().globalConfigFile;
  if (fs.existsSync(file)) return;
  const seed = {
    providers: PROVIDER_PRESETS.map((p) => ({
      id: p.id,
      baseUrl: p.baseUrl,
      apiKeyEnv: p.apiKeyEnv,
      ...(p.protocol ? { protocol: p.protocol } : {}),
      models: p.models.map((id) => ({ id })),
    })),
  };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    await fsp.writeFile(file, JSON.stringify(seed, null, 2) + "\n", { flag: "wx" });
  } catch (err) {
    // wx 独占冲突 = 并发首启的另一方已落盘：文件已在，不再动
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}
