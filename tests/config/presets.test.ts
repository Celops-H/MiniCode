import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS } from "../../src/config/presets.js";

describe("PROVIDER_PRESETS（厂商预设）", () => {
  it("id 全局唯一（同厂商多接入方式也用不同 id 平铺）", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每条预设字段完整：defaultModel 必在 models 内，models 非空", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.baseUrl.startsWith("https://")).toBe(true);
      expect(p.apiKeyEnv.length).toBeGreaterThan(0);
      expect(p.models.length).toBeGreaterThan(0);
      expect(p.models).toContain(p.defaultModel);
    }
  });

  it("Anthropic 兼容条目显式标注协议，其余缺省 openai-chat-completions", () => {
    const anthropicIds = ["deepseek-anthropic", "moonshot-anthropic", "zhipu-coding"];
    for (const p of PROVIDER_PRESETS) {
      if (anthropicIds.includes(p.id)) {
        expect(p.protocol).toBe("anthropic-messages");
        expect(p.baseUrl).toMatch(/anthropic/);
      } else {
        expect(p.protocol).toBeUndefined();
      }
    }
  });

  it("覆盖对齐的厂商与接入方式：GLM 两条、DeepSeek/Kimi 含 Anthropic 条目", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["zhipu", "zhipu-coding", "deepseek", "deepseek-anthropic", "moonshot", "moonshot-anthropic"]),
    );
  });
});
