import { z } from "zod";

/**
 * 工具基类：工具只声明自身属性，不感知权限规则与执行调度。
 * 各属性由对应子系统消费（Registry 序列化 / Permission 审批 / Executor 执行）。
 */
export interface Tool {
  /** 工具唯一名 */
  readonly name: string;
  readonly description: string;
  /** 参数 schema（zod），Executor 校验输入 */
  readonly inputSchema: z.ZodTypeAny;
  /** 只读工具：权限快速放行 */
  readonly isReadOnly: boolean;
  /** 需要用户交互：升级审批 */
  readonly requiresUserInteraction: boolean;
  /** 最大结果字符数：超出截断 */
  readonly maxResultSizeChars: number;
  /** 并发安全判断：按具体输入判断，不确定返回 false（保守） */
  isConcurrencySafe?(input: unknown): boolean;
  /** 执行工具，返回文本结果 */
  execute(input: unknown): Promise<string> | string;
}

/** 校验工具输入；schema 校验失败抛出 */
export function validateInput<T>(tool: Pick<Tool, "name" | "inputSchema">, input: unknown): T {
  return tool.inputSchema.parse(input) as T;
}
