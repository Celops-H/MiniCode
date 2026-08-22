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
    .map((line) => JSON.parse(line) as T);
}

/**
 * 追加一行到 JSONL 文件，自动创建父目录。
 * @param file 文件路径
 * @param item 待序列化追加的对象
 */
export async function appendJsonl<T>(file: string, item: T): Promise<void> {
  await appendJsonlBatch(file, [item]);
}

/**
 * 批量追加多行到 JSONL 文件，一次 I/O 写完整批（避免逐条 append 的系统调用开销）。
 * @param file 文件路径
 * @param items 待序列化追加的对象数组
 */
export async function appendJsonlBatch<T>(file: string, items: T[]): Promise<void> {
  if (items.length === 0) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, items.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf8");
}
