/**
 * Windows 终端输入初始化（opencode 的 terminal-win32 对应，node:ffi 版）。
 * opentui 原生层在 Windows 下读控制台输入时，控制台的 PROCESSED_INPUT 标志未清除会导致
 * Ctrl+C 等按键被终端处理、原始字节不完整进应用（opencode 官方也在启动时调用这些）。
 * 需 --experimental-ffi（package.json dev:tui/test 已注入）。
 */
import { dlopen, types } from "node:ffi";

const STD_INPUT_HANDLE = -10;
const ENABLE_PROCESSED_INPUT = 0x0001;

interface Kernel {
  functions: {
    GetStdHandle(handle: number): bigint | null;
    GetConsoleMode(handle: bigint | null, modeBuf: Uint32Array): number;
    SetConsoleMode(handle: bigint | null, mode: number): number;
    FlushConsoleInputBuffer(handle: bigint | null): number;
  };
}

function load(): Kernel | null {
  if (process.platform !== "win32") return null;
  try {
    return dlopen("kernel32.dll", {
      GetStdHandle: { arguments: [types.INT_32], return: types.POINTER },
      GetConsoleMode: { arguments: [types.POINTER, types.POINTER], return: types.INT_32 },
      SetConsoleMode: { arguments: [types.POINTER, types.UINT_32], return: types.INT_32 },
      FlushConsoleInputBuffer: { arguments: [types.POINTER], return: types.INT_32 },
    }) as unknown as Kernel;
  } catch {
    return null;
  }
}

/** 清除控制台 stdin 的 PROCESSED_INPUT（让 Ctrl+C 等以原始字节进应用） */
export function win32DisableProcessedInput(): void {
  if (process.platform !== "win32") return;
  if (!process.stdin.isTTY) return;
  const k = load();
  if (!k) return;
  const handle = k.functions.GetStdHandle(STD_INPUT_HANDLE);
  if (handle === null) return;
  const modeBuf = new Uint32Array(1);
  if (k.functions.GetConsoleMode(handle, modeBuf) === 0) return;
  const mode = modeBuf[0]!;
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return;
  k.functions.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT);
}

/** 丢弃排队控制台输入（按键/鼠标缓冲，进 TUI 前清空避免误触发） */
export function win32FlushInputBuffer(): void {
  if (process.platform !== "win32") return;
  if (!process.stdin.isTTY) return;
  const k = load();
  if (!k) return;
  const handle = k.functions.GetStdHandle(STD_INPUT_HANDLE);
  if (handle !== null) k.functions.FlushConsoleInputBuffer(handle);
}