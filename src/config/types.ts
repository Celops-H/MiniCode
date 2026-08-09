import { z } from "zod";

/** 配置 schema：config 模块是 schema 单一权威，随功能演进扩展字段 */
export const configSchema = z.object({
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;
