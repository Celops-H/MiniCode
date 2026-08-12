import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { validateInput } from "../base.js";
import type { Tool } from "../base.js";

const schema = z.object({
  path: z.string(),
  /** 待替换的旧文本，须在文件中唯一匹配 */
  oldString: z.string(),
  newString: z.string(),
});

/** 精确替换文件中的一段文本；旧文本不唯一或不存在时拒绝 */
export const editTool: Tool = {
  name: "edit",
  description: "在文件中精确替换一段文本，旧文本须唯一匹配",
  inputSchema: schema,
  isReadOnly: false,
  requiresUserInteraction: false,
  maxResultSizeChars: 1000,
  async execute(input) {
    const { path, oldString, newString } = validateInput<{
      path: string;
      oldString: string;
      newString: string;
    }>(editTool, input);

    const content = await readFile(path, "utf8");
    const firstIndex = content.indexOf(oldString);
    if (firstIndex === -1) {
      return `未找到待替换的文本`;
    }
    const count = content.split(oldString).length - 1;
    if (count > 1) {
      return `待替换文本出现 ${count} 次，须唯一匹配`;
    }

    const updated = content.slice(0, firstIndex) + newString + content.slice(firstIndex + oldString.length);
    await writeFile(path, updated, "utf8");
    return `已替换 1 处`;
  },
};
