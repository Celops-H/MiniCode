import { describe, expect, it } from "vitest";
import { resolveAuth } from "../../src/llm/auth.js";

describe("resolveAuth（环境变量与落盘 key 同权，E33）", () => {
  it("环境变量命中：source=env，优先于落盘 key（显式注入的临时 key 覆盖落盘值）", () => {
    const result = resolveAuth({ apiKeyEnv: "A", storedKey: "stored-key", env: { A: "env-key" } });
    expect(result).toEqual({ auth: { configured: true, source: "env" }, apiKey: "env-key" });
  });

  it("仅落盘 key：source=stored，视为已配置", () => {
    const result = resolveAuth({ apiKeyEnv: "A", storedKey: "stored-key", env: {} });
    expect(result).toEqual({ auth: { configured: true, source: "stored" }, apiKey: "stored-key" });
  });

  it("两者皆无：未配置", () => {
    expect(resolveAuth({ apiKeyEnv: "A", env: {} })).toEqual({ auth: { configured: false } });
    // 落盘 key 为空串等同未配置
    expect(resolveAuth({ apiKeyEnv: "A", storedKey: "", env: {} })).toEqual({ auth: { configured: false } });
  });
});
