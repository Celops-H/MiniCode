/**
 * 放 core 这一层：CLI 与 TUI 两个宿主要套同一套文案，且 src/tui 不参与 tsc 构建
 * （TUI 由 vite 单独打包），下层模块反向依赖它会让 dist 缺文件。
 */

/** 模型调用失败的可读提示：识别认证/配置类错误追加「换模型/配 key」引导，其它错误保持原样。
 *  覆盖切到无 API Key 模型、key 无效（401/403）、模型 id 无效（404/未找到/未知模型）场景。
 *  错误入口统一（interact catch 与 reduceEvent error）都套它，避免 SDK 原文裸抛看不懂。 */
export function modelErrorText(error: string): string {
  const markers = [
    "未配置认证",
    "请设置环境变量",
    "未知模型",
    "401",
    "403",
    "404",
    "does not exist",
    "not found",
    "Incorrect API key",
    "api key",
    "authentication",
  ] as const;
  if (markers.some((m) => error.toLowerCase().includes(m.toLowerCase()))) {
    return `${error}\n可用 /model 换模型，或 /connect 连接厂商配置 API Key`;
  }
  return error;
}
