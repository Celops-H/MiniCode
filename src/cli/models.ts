import type { Config } from "../config/index.js";
import { resolveAuth } from "../llm/auth.js";
import {
  AnthropicCompatibleProvider,
  ModelRouter,
  Models,
  OpenAICompatibleProvider,
} from "../llm/index.js";

/** 可用厂商为零时的启动报错（无任何兜底：列表里出现的模型一定有 key，无例外） */
export const NO_PROVIDER_ERROR =
  "未配置任何可用厂商：请 /connect 连接供应商（或配置对应 API key 环境变量），或编辑 ~/.minicode/config.json";

/**
 * 按配置构建模型客户端：config 配置了 providers → 注册多厂商 Provider（按 provider
 * 的 protocol 选工厂，缺省 openai-chat-completions），
 * 且配置了 modelChain → 挂 ModelRouter 优先级链路由。
 * 装配期逐 provider 查 apiKeyEnv（resolveAuth）：key 已配置才注册，未配置的不进
 * 模型列表（列表里出现的模型一定有 key，无例外）；可用厂商为零直接报错，不再回退
 * 硬编码兜底（删除文件重启即按预设重新播种，见 config/seed.ts）。
 * -m 指定时以其为主模型打头（配置的 modelChain 作为备选路由）；-m 未在配置中出现则
 * 显式报错，不静默忽略。
 * @param config 配置（providers / modelChain 可选）
 * @param modelId 模型 id 覆盖（-m 选项），可省略
 * @param opts 环境变量注入（测试用；缺省读 process.env，宿主启动时已注入项目 .env）
 * @returns 注册了 Provider 的 Models 集合
 */
export function buildModelClient(
  config: Config | undefined,
  modelId?: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Models {
  const env = opts.env ?? process.env;
  // key 过滤：无 key 的厂商不注册（调用了也必然认证失败，进列表只会误导 /model 选择）
  const usable = (config?.providers ?? []).filter(
    (p) => resolveAuth({ apiKeyEnv: p.apiKeyEnv, env }).auth.configured,
  );
  if (usable.length === 0) throw new Error(NO_PROVIDER_ERROR);
  // -m 存在时以其为主模型打头，配置的 modelChain 作备选路由
  const chain = modelId ? [modelId, ...(config?.modelChain ?? [])] : config?.modelChain;
  const models = new Models({
    router: chain && chain.length > 0 ? new ModelRouter() : undefined,
    chain,
  });
  // 跨厂商同 id 模型限定 provider：模型路由全局只认 id，后注册的重复 id 会永远路由到
  // 首个厂商（如 DeepSeek 的 OpenAI 端点与 Anthropic 兼容端点模型 id 相同），后者不可达。
  // 重复 id 以「模型id@厂商id」的限定名注册（厂商侧请求仍用原始 id，见 vendorId）
  const seenModelIds = new Set<string>();
  for (const provider of usable) {
    const protocol = provider.protocol ?? "openai-chat-completions";
    const modelInfos = provider.models.map((m) => {
      const vendorId = seenModelIds.has(m.id) ? `${m.id}@${provider.id}` : undefined;
      seenModelIds.add(m.id);
      return {
        id: vendorId ?? m.id,
        vendorId,
        name: m.name ?? m.id,
        api: protocol,
        providerId: provider.id,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      };
    });
    if (protocol === "anthropic-messages") {
      // Anthropic 兼容端点：x-api-key + anthropic-version 认证头与流式解析随协议走
      models.register(
        new AnthropicCompatibleProvider({
          id: provider.id,
          name: provider.id,
          baseUrl: provider.baseUrl,
          apiKeyEnv: provider.apiKeyEnv,
          env,
          models: modelInfos,
        }),
      );
    } else {
      models.register(
        new OpenAICompatibleProvider({
          id: provider.id,
          name: provider.id,
          baseUrl: provider.baseUrl,
          apiKeyEnv: provider.apiKeyEnv,
          env,
          // DeepSeek 等推理厂商：thinking 必须回传 reasoning_content，否则工具调用后下一轮 400
          reasoningContent: provider.id === "deepseek",
          // 仅 OpenAI 官方支持 reasoning_effort 请求参数；其余厂商发该字段可能 400，不开
          reasoningEffort: provider.id === "openai",
          models: modelInfos,
        }),
      );
    }
  }
  // 主模型必须可解析：不在配置中则显式报错，避免会话运行时才「未知模型」崩溃
  const main = resolveMainModel(config, modelId, { env });
  if (!models.resolve(main)) {
    throw new Error(
      `模型 ${main} 不可用：请确认其所属厂商的 API key 已配置、模型在 providers 中，或调整 -m / modelChain`,
    );
  }
  return models;
}

/**
 * 解析会话主模型：-m 选项 > 优先级链首（modelChain[0]）> **key 就绪**的 providers
 * 首个模型；都没有则报错（无默认模型兜底，配置播种后种子 providers 必有模型）。
 * 「providers 首个」与 buildModelClient 的 key 过滤一致——未配置 key 的厂商不进
 * 注册集合，取它的模型做主模型只会启动失败（BACKEND §14）。
 * @param config 配置
 * @param modelId -m 选项指定的模型 id，可省略
 * @param opts 环境变量注入（测试用；缺省读 process.env）
 * @returns 主模型 id
 */
export function resolveMainModel(
  config?: Config,
  modelId?: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): string {
  if (modelId) return modelId;
  const env = opts.env ?? process.env;
  const usable = (config?.providers ?? []).filter(
    (p) => resolveAuth({ apiKeyEnv: p.apiKeyEnv, env }).auth.configured,
  );
  const main = config?.modelChain?.[0] ?? usable[0]?.models[0]?.id;
  if (!main) throw new Error(NO_PROVIDER_ERROR);
  return main;
}
