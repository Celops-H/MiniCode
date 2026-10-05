import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
      expect(p.models.map((m) => m.id)).toContain(p.defaultModel);
    }
  });

  it("能力位名单自洽：reasoningModels 是 models 的子集（笔误会静默丢标记）", () => {
    for (const p of PROVIDER_PRESETS) {
      for (const id of p.reasoningModels ?? []) {
        expect(p.models.map((m) => m.id), `${p.id} 的 reasoningModels 含未声明模型 ${id}`).toContain(id);
      }
    }
  });

  it("窗口与输出上限为正数（目录核实值原样烙入，笔误直接暴露）", () => {
    for (const p of PROVIDER_PRESETS) {
      for (const m of p.models) {
        if (m.contextWindow !== undefined) expect(m.contextWindow).toBeGreaterThan(0);
        if (m.maxTokens !== undefined) expect(m.maxTokens).toBeGreaterThan(0);
      }
    }
  });

  it("Anthropic 兼容条目显式标注协议，其余缺省 openai-chat-completions", () => {
    const anthropicIds = ["moonshot-anthropic", "zhipu-coding"];
    for (const p of PROVIDER_PRESETS) {
      if (anthropicIds.includes(p.id)) {
        expect(p.protocol).toBe("anthropic-messages");
        expect(p.baseUrl).toMatch(/anthropic/);
      } else {
        expect(p.protocol).toBeUndefined();
      }
    }
  });

  it("覆盖对齐的厂商与接入方式：GLM 两条、Kimi 含 Anthropic 条目", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["zhipu", "zhipu-coding", "deepseek", "moonshot", "moonshot-anthropic"]),
    );
  });

  it("zhipu 计费端点清单与内置目录一致：模型在目录内，窗口与输出上限同目录值", () => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === "zhipu");
    expect(preset).toBeDefined();
    const snapshotFile = fileURLToPath(new URL("../../src/llm/models-dev.json", import.meta.url));
    const catalog = JSON.parse(readFileSync(snapshotFile, "utf8")) as {
      zhipuai?: { models?: Record<string, { limit?: { context?: number; output?: number } }> };
    };
    const catalogModels = catalog.zhipuai?.models ?? {};
    for (const m of preset!.models) {
      const entry = catalogModels[m.id];
      expect(entry, `模型 ${m.id} 不在目录 zhipuai 条目内（预设与目录失同步）`).toBeTruthy();
      expect(m.contextWindow, `${m.id} contextWindow 与目录不一致`).toBe(entry?.limit?.context);
      expect(m.maxTokens, `${m.id} maxTokens 与目录不一致`).toBe(entry?.limit?.output);
    }
  });
});
