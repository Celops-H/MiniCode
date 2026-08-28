import type { Config } from "../config/index.js";
import { resolveAuth } from "../llm/auth.js";
import { ModelRouter, Models, OpenAICompatibleProvider } from "../llm/index.js";

/** 可用厂商为零时的启动报错（无任何兜底：列表里出现的模型一定有 key，无例外） */
export const NO_PROVIDER_ERROR =
  "未配置任何可用厂商：请 /connect 连接供应商（或配置对应 API key 环境变量），或编辑 ~/.minicode/config.json";

/**
 * 按配置构建模型客户端：config 配置了 providers → 注册多厂商 Provider，
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
  for (const provider of usable) {
    models.register(
      new OpenAICompatibleProvider({
        id: provider.id,
        name: provider.id,
        baseUrl: provider.baseUrl,
        apiKeyEnv: provider.apiKeyEnv,
        // DeepSeek 等推理厂商：thinking 必须回传 reasoning_content，否则工具调用后下一轮 400
        reasoningContent: provider.id === "deepseek",
        // 仅 OpenAI 官方支持 reasoning_effort 请求参数；其余厂商发该字段可能 400，不开
        reasoningEffort: provider.id === "openai",
        models: provider.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          api: "openai-chat-completions",
          providerId: provider.id,
          contextWindow: m.contextWindow,
        })),
      }),
    );
  }
  // 主模型必须可解析：不在配置中则显式报错，避免会话运行时才「未知模型」崩溃
  const main = resolveMainModel(config, modelId);
  if (!models.resolve(main)) {
    throw new Error(`模型 ${main} 未在配置的 providers 中，请检查模型配置或去掉 -m`);
  }
  return models;
}

/**
 * 解析会话主模型：-m 选项 > 优先级链首（modelChain[0]）> providers 首个模型；
 * 都没有则报错（无默认模型兜底，配置播种后种子 providers 必有模型）。
 * 与 buildModelClient 的注册集合保持一致，保证主模型一定可解析。
 * @param config 配置
 * @param modelId -m 选项指定的模型 id，可省略
 * @returns 主模型 id
 */
export function resolveMainModel(config?: Config, modelId?: string): string {
  const main = modelId ?? config?.modelChain?.[0] ?? config?.providers?.[0]?.models[0]?.id;
  if (!main) throw new Error(NO_PROVIDER_ERROR);
  return main;
}
