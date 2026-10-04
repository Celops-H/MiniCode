/**
 * 构建资源拷贝：tsc 只编译 TS，不复制非代码资源。
 * 模型目录离线快照（src/llm/models-dev.json）按源码相对路径被 catalog.js 以
 * import.meta.url 定位读取，须随编译产物落到 dist/llm/ 同位。
 */
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(root, "dist", "llm");
mkdirSync(target, { recursive: true });
copyFileSync(path.join(root, "src", "llm", "models-dev.json"), path.join(target, "models-dev.json"));
console.log("copied src/llm/models-dev.json -> dist/llm/models-dev.json");
