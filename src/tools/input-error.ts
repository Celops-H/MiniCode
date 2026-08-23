import { z } from "zod";

/**
 * 把工具参数校验错误（ZodError）格式化为模型可读的错误文本。
 * 缺失参数翻译为「缺失」，未识别字段列出具体字段名，其余保留 zod 的
 * 期望/收到说明（如 Expected string, received number），供模型调整后重新调用。
 * @param toolName 工具名
 * @param error zod 校验错误
 * @returns 可读错误文本
 */
export function formatInputError(toolName: string, error: z.ZodError): string {
  const details = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(根级)";
    // zod 4 缺失字段：invalid_type 且 message 以 received undefined 结尾（无独立 received 字段）
    if (issue.code === "invalid_type" && issue.message.includes("received undefined")) {
      return `参数 ${path}：缺失`;
    }
    if (issue.code === "unrecognized_keys") {
      const keys = (issue as { keys: string[] }).keys.join("、");
      return `参数 ${path}：未识别字段 ${keys}`;
    }
    return `参数 ${path}：${issue.message}`;
  });
  return `工具 ${toolName} 参数不合法：${details.join("；")}`;
}
