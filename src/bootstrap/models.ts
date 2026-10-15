import type { Config, ProviderConfig } from "../config/index.js";
import { PROVIDER_PRESETS } from "../config/presets.js";
import { resolveAuth } from "../llm/auth.js";
import { lookupModelLimits, type CatalogLookup } from "../llm/catalog.js";
import {
  AnthropicCompatibleProvider,
  ModelRouter,
  Models,
  OpenAICompatibleProvider,
} from "../llm/index.js";
import type { AnthropicMessagesClient, AnthropicMessagesClientFactory, ChatCompletionsClient, ChatCompletionsClientFactory } from "../llm/index.js";

/** 零可用厂商错误文案（列表里出现的模型一定有 key，无例外） */
const NO_PROVIDER_ERROR =
  "未配置任何可用厂商：请 /connect 连接供应商（或配置对应 API key 环境变量），或编辑 ~/.minicode/config.json";

/** 零可用厂商错误：装配期无 key 就绪的厂商时抛出。TUI 入口按 instanceof 判定进连接引导——
 *  用错误类型而非文案比对，文案调整不会让引导态判定失效 */
export class NoProviderError extends Error {
  constructor() {
    super(NO_PROVIDER_ERROR);
    this.name = "NoProviderError";
  }
}

/** 预设按 provider id 索引：能力位缺省回填用（存量配置兼容，见 buildModelClient） */
const PRESET_BY_ID = new Map(PROVIDER_PRESETS.map((p) => [p.id, p]));

/** key 就绪的厂商（配置落盘 apiKey 与环境变量同权，任一存在即可用）：无 key 的厂商不注册，
 *  调用了也必然认证失败，进列表只会误导 /model 选择 */
function usableProviders(config: Config | undefined, env: NodeJS.ProcessEnv): ProviderConfig[] {
  return (config?.providers ?? []).filter(
    (p) => resolveAuth({ apiKeyEnv: p.apiKeyEnv, storedKey: p.apiKey, env }).auth.configured,
  );
}

/**
 * 按配置构建模型客户端：config 配置了 providers → 注册多厂商 Provider（按 provider
 * 的 protocol 选工厂，缺省 openai-chat-completions），
 * 且优先级链总开关开启（modelChainEnabled 缺省开）并配置了 modelChain → 挂 ModelRouter
 * 优先级链路由；开关关闭时只用主模型，出错不再自动切备选。
 * 装配期逐 provider 查 apiKeyEnv（resolveAuth）：key 已配置才注册，未配置的不进
 * 模型列表（列表里出现的模型一定有 key，无例外）；可用厂商为零抛 NoProviderError
 * 走连接引导，不再回退硬编码兜底（删除文件重启即按预设重新播种，见 config/seed.ts）。
 * -m 指定时以其为主模型打头（配置的 modelChain 作为备选路由）；-m 不可解析则显式报错，
 * 不静默忽略也不回落。defaultModel 与 modelChain 条目不可解析只告警不阻断（运行时按
 * 候选顺序回落到首个可解析模型，见 pickMainModel）；优先级链总开关关闭时链不参与运行时
 * 路由，链条目告警一并跳过。
 * @param config 配置（providers / modelChain 可选）
 * @param modelId 模型 id 覆盖（-m 选项），可省略
 * @param opts.env 环境变量注入（测试用；缺省读 process.env，宿主启动时已注入项目 .env）
 * @param opts.createOpenAIClient / opts.createAnthropicClient client 工厂注入（测试用；
 *   缺省用各 Provider 的默认 SDK 工厂），可端到端断言配置 → 请求体的能力位接线
 * @param opts.catalog 模型目录查询注入（测试用；缺省查 models.dev 目录）：
 *   配置未写窗口/输出上限的模型按目录代查，仍未命中由消费方按兜底常量处理
 * @param opts.onWarning 装配告警回调（defaultModel/modelChain 死条目等非致命问题）；
 *   缺省输出到 stderr，TUI 宿主注入收集器转为界面提示（console 直写在全屏界面下会花屏）
 * @returns 注册了 Provider 的 Models 集合
 */
export function buildModelClient(
  config: Config | undefined,
  modelId?: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    createOpenAIClient?: ChatCompletionsClientFactory;
    createAnthropicClient?: AnthropicMessagesClientFactory;
    catalog?: CatalogLookup;
    onWarning?: (message: string) => void;
  } = {},
): Models {
  const env = opts.env ?? process.env;
  const usable = usableProviders(config, env);
  if (usable.length === 0) throw new NoProviderError();
  // -m 存在时以其为主模型打头，配置的 modelChain 作备选路由。
  // 优先级链总开关（缺省开）：关闭时链不进装配（router 与 chain 都不给，Models 退化为
  // 单模型直连），出错不再自动切备选；链成员与顺序仍由 modelChain 定义，清空 modelChain
  // 不是关闭方式。只拆路由不动主模型解析：defaultModel > modelChain[0] > 兜底的候选
  // 照旧（见 mainModelCandidates），链上不可解析条目的装配告警也随之跳过（链不参与
  // 运行时路由，告警没有意义）
  const chainEnabled = config?.modelChainEnabled ?? true;
  const chain = chainEnabled
    ? modelId
      ? [modelId, ...(config?.modelChain ?? [])]
      : config?.modelChain
    : undefined;
  const models = new Models({
    router: chain && chain.length > 0 ? new ModelRouter() : undefined,
    chain,
  });
  // 跨厂商同 id 模型限定 provider：模型路由全局只认 id，后注册的重复 id 会永远路由到
  // 首个厂商（如 DeepSeek 的 OpenAI 端点与 Anthropic 兼容端点模型 id 相同），后者不可达。
  // 重复 id 以「模型id@厂商id」的限定名做注册 id；厂商侧请求仍用原始模型 id——provider
  // 发请求取的就是 vendorId（曾把 vendorId 赋成限定名本身，限定名条目请求厂商 400
  // 「模型不存在」），此处必须保持原始 id
  const seenModelIds = new Set<string>();
  for (const provider of usable) {
    const protocol = provider.protocol ?? "openai-chat-completions";
    // 能力位缺省回填预设默认值（存量配置兼容）：能力位进配置前播种的老 config 没有
    // 这些字段，若按 undefined 一律当 false，DeepSeek 工具轮思考回传缺失 400 等
    // 已修问题会在存量用户上复发。字段未写（undefined）时按同 id 预设补默认，
    // 用户显式写的值（含 false）优先——只填空不覆盖，用户配置仍是权威
    const preset = PRESET_BY_ID.get(provider.id);
    const reasoningContent = provider.reasoningContent ?? preset?.reasoningContent;
    const reasoningEffort = provider.reasoningEffort ?? preset?.reasoningEffort;
    const enableThinking = provider.enableThinking ?? preset?.enableThinking;
    const includeUsage = provider.includeUsage ?? preset?.includeUsage;
    // 模型目录按目录侧厂商键查（预设 id 与目录键不一致的经 catalogId 映射；
    // 自建 provider 用 id 直查，目录键对不上的自然查空）
    const catalog = opts.catalog ?? lookupModelLimits;
    const catalogProviderId = preset?.catalogId ?? provider.id;
    const modelInfos = provider.models.map((m) => {
      const qualified = seenModelIds.has(m.id) ? `${m.id}@${provider.id}` : undefined;
      seenModelIds.add(m.id);
      // 窗口/输出上限来源优先级：配置手写 > 厂商 /models 抓取（连接时已写回配置，
      // 同样落在 m 上）> models.dev 目录代查 > 兜底常量（消费方处理）
      const limits = m.contextWindow === undefined || m.maxTokens === undefined
        ? catalog(catalogProviderId, m.id)
        : undefined;
      return {
        id: qualified ?? m.id,
        vendorId: qualified ? m.id : undefined,
        name: m.name ?? m.id,
        api: protocol,
        providerId: provider.id,
        contextWindow: m.contextWindow ?? limits?.contextWindow,
        maxTokens: m.maxTokens ?? limits?.maxTokens,
        // 推理系列模型能力位：思考类请求参数仅对推理系列模型下发；
        // 未标记的模型按预设的推理系列名单回填
        reasoning: m.reasoning ?? preset?.reasoningModels?.includes(m.id),
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
          apiKey: provider.apiKey,
          env,
          headers: provider.headers,
          models: modelInfos,
          createClient: opts.createAnthropicClient,
        }),
      );
    } else {
      models.register(
        new OpenAICompatibleProvider({
          id: provider.id,
          name: provider.id,
          baseUrl: provider.baseUrl,
          apiKeyEnv: provider.apiKeyEnv,
          apiKey: provider.apiKey,
          env,
          // 厂商能力开关：一律来自 provider 配置字段（缺省按预设回填），
          // 不再按 provider.id 硬编码（自建 provider 与聚合商同样可表达；粒度与语义
          // 见 config schema）
          reasoningContent,
          reasoningEffort,
          enableThinking,
          includeUsage,
          headers: provider.headers,
          models: modelInfos,
          // 诊断开关（调试排查「流活跃但零输出」的静默卡死）：config.debug.streamChunks
          debugDroppedChunks: config?.debug?.streamChunks === true,
          createClient: opts.createOpenAIClient,
        }),
      );
    }
  }
  // -m 显式指定时硬校验：用户点名的模型不可解析直接报错，不静默回落（其余路径按候选回退，
  // 见 pickMainModel）
  if (modelId && !models.resolve(modelId)) {
    throw new Error(
      `模型 ${modelId} 不可用：请确认其所属厂商的 API key 已配置、模型在 providers 中，或调整 -m / defaultModel / modelChain`,
    );
  }
  // 候选条目（defaultModel、modelChain）不可解析只告警不阻断：运行时按候选顺序回落到首个
  // 可解析模型，用户应在装配期就知道哪些条目是死的。链开关关闭时链不参与运行时路由，
  // 链条目告警一并跳过（链不参与路由，告警没有意义）
  const onWarning = opts.onWarning ?? ((message: string) => console.error(message));
  const warned = new Set<string>();
  const warnIfDead = (id: string, label: string): void => {
    if (warned.has(id) || models.resolve(id)) return;
    warned.add(id);
    onWarning(`${label} ${id} 不可解析：所属厂商 key 未配置或模型不在 providers 中，已按候选顺序跳过`);
  };
  for (const entry of chain ?? []) warnIfDead(entry, "模型链条目");
  if (!modelId && config?.defaultModel) warnIfDead(config.defaultModel, "默认模型");
  return models;
}

/** 主模型候选序列（去重保序）：defaultModel > modelChain 顺序 > 可用首模型。
 *  可用首模型取第一个「有模型」的可用厂商的模型（厂商 models 可为空数组，跳过它继续找）。 */
function mainModelCandidates(config: Config | undefined, opts: { env?: NodeJS.ProcessEnv } = {}): string[] {
  const usable = usableProviders(config, opts.env ?? process.env);
  const fallback = usable.find((p) => p.models[0]);
  return [
    ...new Set([
      ...(config?.defaultModel ? [config.defaultModel] : []),
      ...(config?.modelChain ?? []),
      ...(fallback?.models[0] ? [fallback.models[0].id] : []),
    ]),
  ];
}

/**
 * 装配期主模型解析：按候选序列（defaultModel > modelChain 顺序 > 可用首模型）逐候选取首个
 * 可解析者。defaultModel 或 modelChain 指向已删模型、所属厂商 key 已删时回落到后续候选，
 * 不阻断启动（另有可用厂商即可用）；全部候选不可解析或无候选抛 NoProviderError。
 * 不判可解析性的「首选」见 resolveMainModel（/session 新建等暂不持有模型集合的路径）。
 * @param models 已注册的模型集合（buildModelClient 产物）
 * @param config 配置
 * @param opts.env 环境变量注入（测试用；缺省读 process.env）
 * @returns 可解析的主模型 id
 */
export function pickMainModel(
  models: Models,
  config?: Config,
  opts: { env?: NodeJS.ProcessEnv } = {},
): string {
  for (const candidate of mainModelCandidates(config, opts)) {
    if (models.resolve(candidate)) return candidate;
  }
  throw new NoProviderError();
}

/**
 * 解析会话首选主模型（纯函数，不判可解析性）：-m 选项 > 候选序列首个
 * （defaultModel > modelChain[0] > 可用首模型）；无任何候选抛 NoProviderError
 * （无默认模型兜底，配置播种后种子 providers 必有模型）。
 * 「可用」与 buildModelClient 的 key 过滤一致——未配置 key 的厂商不进候选，
 * 取它的模型做主模型只会启动失败。
 * 首选条目不可解析时装配期按候选回退到下一个可解析者（见 pickMainModel）；需要该回退的
 * 路径请用 pickMainModel，本函数供暂不持有模型集合的调用方（如 /session 新建）取首选。
 * @param config 配置
 * @param modelId -m 选项指定的模型 id，可省略
 * @param opts 环境变量注入（测试用；缺省读 process.env）
 * @returns 首选主模型 id
 */
export function resolveMainModel(
  config?: Config,
  modelId?: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): string {
  if (modelId) return modelId;
  const first = mainModelCandidates(config, opts)[0];
  if (!first) throw new NoProviderError();
  return first;
}
