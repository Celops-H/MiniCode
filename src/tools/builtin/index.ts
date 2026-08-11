import type { Tool } from "../base.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";

/** 文件类内置工具集合 */
export function createFileTools(): Tool[] {
  return [readTool, writeTool, globTool, grepTool];
}
