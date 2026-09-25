import { describe, expect, it } from "vitest";
import { modelErrorText } from "../../src/core/index.js";

describe("modelErrorText：模型调用失败的可读引导（C2 /model 边界）", () => {
  it("认证/未配置/未知模型类错误追加换模型与配 key 引导", () => {
    expect(modelErrorText("Provider openai 未配置认证：请设置环境变量")).toContain("/model 换模型");
    expect(modelErrorText("Incorrect API key provided. 401")).toContain("/connect");
    expect(modelErrorText("未知模型：gpt-9")).toContain("/model 换模型");
    // 厂商侧模型下架/改名（404 / 英文未找到）：同样给换模型引导
    expect(modelErrorText("404 The model 'gpt-9' does not exist")).toContain("/model 换模型");
    expect(modelErrorText("model not found")).toContain("/model 换模型");
  });
  it("其它错误保持原样，不误导", () => {
    expect(modelErrorText("会话存储写入失败")).toBe("会话存储写入失败");
  });
});
