import { z } from "zod";

/**
 * 上下文修改器：工具执行后可对宿主上下文做的延迟修改。
 * 并发批内不立即执行，整批结束后按工具声明顺序统一执行，保证并发下上下文演化确定。
 * 形如无参函数：宿主（主循环）在闭包里持有可变上下文，应用即调用。
 */
export type ContextModifier = () => void;

/** 工具执行结果：纯文本，或结构化结果（额外携带上下文修改、失败标记） */
export type ExecuteResult =
  | string
  | {
      /** 回灌模型的文本结果 */
      output: string;
      /** 该执行产出的上下文修改，并发批内批末统一应用 */
      contextModifier?: ContextModifier;
      /** 显式标记该执行失败（如超时），回灌时 isError 置 true */
      isError?: boolean;
    };

/** 工具执行上下文：携带可中止信号（turn 内打断透传，bash 等长进程据此杀进程树） */
export interface ExecuteContext {
  signal?: AbortSignal;
}

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
  /**
   * 直接透传给模型的 JSON Schema（MCP 外部工具用，BACKEND §19）：server 提供的入参 schema，
   * registry 序列化时原样透传、不经 zod 转换；此时 inputSchema 应配 z.unknown() 放行，
   * 入参正确性交给 server 自校验。
   */
  readonly inputJsonSchema?: Record<string, unknown>;
  /** 只读工具：权限快速放行 */
  readonly isReadOnly: boolean;
  /** 需要用户交互：升级审批 */
  readonly requiresUserInteraction: boolean;
  /** 免审批放行：低影响工具（如 agent 消息投递）不进入权限审批链（DESIGN 7.1） */
  readonly skipsPermission?: boolean;
  /** 最大结果字符数：超出截断 */
  readonly maxResultSizeChars: number;
  /** 并发安全判断：按具体输入判断，不确定返回 false（保守） */
  isConcurrencySafe?(input: unknown): boolean;
  /** 执行工具，返回文本或结构化结果；慢工具可响应 ctx.signal 中止 */
  execute(input: unknown, options?: ExecuteContext): Promise<ExecuteResult> | ExecuteResult;
}

/**
 * 用工具的 zod schema 校验输入并返回解析后的类型化值；校验失败抛出。
 * @param tool 工具（取 name 与 inputSchema）
 * @param input 待校验的工具参数
 * @returns 校验通过的类型化参数
 */
export function validateInput<T>(tool: Pick<Tool, "name" | "inputSchema">, input: unknown): T {
  return tool.inputSchema.parse(input) as T;
}
