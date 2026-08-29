import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * 逐行读取 JSONL 文件。
 * @param file 文件路径
 * @returns 解析出的对象数组；文件不存在返回空数组
 */
export async function readJsonl<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        // 坏行跳过（DESIGN 14 可修复）：写盘中断的半行或损坏行不拖垮整会话加载——
        // 宁可丢这一条，也不能让整个会话读不出来
        return [];
      }
    });
}

/**
 * 批量追加多行到 JSONL 文件，一次 I/O 写完整批（避免逐条 append 的系统调用开销）。
 * @param file 文件路径
 * @param items 待序列化追加的对象数组
 */
export async function appendJsonlBatch<T>(file: string, items: T[]): Promise<void> {
  if (items.length === 0) return;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // POSIX 600：会话消息文件属用户隐私（Windows 忽略 mode 无副作用）
  await appendFile(file, items.map((item) => `${JSON.stringify(item)}\n`).join(""), { mode: 0o600, encoding: "utf8" });
}
