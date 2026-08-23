import type { Tool } from "../base.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { bashTool } from "./bash.js";
import { bashTaskTool } from "./bash-task.js";
import { editTool } from "./edit.js";
import { createTodoTool } from "./todo.js";

/** 文件类内置工具集合 */
export function createFileTools(): Tool[] {
  return [readTool, writeTool, globTool, grepTool];
}

/** 全部内置工具集合 */
export function createBuiltinTools(): Tool[] {
  return [readTool, writeTool, globTool, grepTool, bashTool, bashTaskTool, editTool, createTodoTool()];
}
