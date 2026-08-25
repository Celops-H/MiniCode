/**
 * Windows 终端输入初始化（opencode 的 terminal-win32 对应）。
 * opentui 原生层在 Windows 下读控制台输入时，控制台的 PROCESSED_INPUT 标志未清除会导致
 * Ctrl+C 等按键被终端处理、原始字节不完整进应用（opencode 官方也在启动时调用这些）。
 *
 * 全程用 process.getBuiltinModule("node:ffi") 而非静态 import：node:ffi 是 Node 26 实验内建，
 * vite-node/vite 8 的解析器不识别它（resolved id 变 ffi 而加载失败），运行时获取绕过打包器解析。
 */
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

interface FfiModule {
  dlopen: (path: string, symbols: Record<string, unknown>) => Kernel;
  types: Record<string, string>;
}

function ffi(): FfiModule | null {
  try {
    return process.getBuiltinModule("node:ffi") as unknown as FfiModule;
  } catch {
    return null;
  }
}

function load(): Kernel | null {
  if (process.platform !== "win32") return null;
  const mod = ffi();
  if (!mod) return null;
  try {
    return mod.dlopen("kernel32.dll", {
      GetStdHandle: { arguments: [mod.types.INT_32], return: mod.types.POINTER },
      GetConsoleMode: { arguments: [mod.types.POINTER, mod.types.POINTER], return: mod.types.INT_32 },
      SetConsoleMode: { arguments: [mod.types.POINTER, mod.types.UINT_32], return: mod.types.INT_32 },
      FlushConsoleInputBuffer: { arguments: [mod.types.POINTER], return: mod.types.INT_32 },
    });
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