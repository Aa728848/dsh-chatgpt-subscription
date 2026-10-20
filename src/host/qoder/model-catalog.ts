/**
 * Qoder（订阅）线路的模型目录：目录解析、能力装配、随包兜底表。
 *
 * 存在的原因是本线路的一条硬规则（与兄弟线路同源）：**能力不得从模型名推断**。
 * 能力字段一律来自 `GET {base}/algo/api/v2/model/list?Encode=1` 的端点字段
 * （`is_vl` / `is_reasoning` / `thinking_config` / `context_config`），拿不到的走区域兜底。
 *
 * ## 随包兜底表
 *
 * 与 step-code 不同，本线路**有**一张随包表：Qoder 的目录请求需要 COSY 签名，
 * 没登录就拿不到目录，而官方 CLI 要求先登录才可用——随包表让「还没登录」的
 * 选择器不为空。表的内容照录 pi-provider-qoder `src/catalog.ts` 的
 * `staticModels` / `staticCnModels`（逐条在注释里给出处）；它是**能力兜底**，
 * 不是权威列表——登录后的运行时目录随时顶替它（client.ts 的缓存与快照）。
 *
 * 真正保证「取不到目录时选择器不为空」的另一半是 {@link undeclaredQoderModelEntry}：
 * 上游给什么 id 就以未声明行进入目录，不猜窗口、不认图、不发档位。
 */

import type {
  QoderModelOption,
  QoderReasoningEffort,
  QoderRegion,
} from '../../shared/qoder-contracts.ts'
import {
  QODER_DEFAULT_CONTEXT_WINDOW,
  QODER_MAX_OUTPUT_TOKENS,
} from './types.ts'

// ---------------------------------------------------------------------------
// 一行模型能力
// ---------------------------------------------------------------------------

/**
 * 一行模型能力。与 `QoderModelOption` 同义，去掉的只是「用户设置」那一半
 * （见 {@link catalogModelOptions}）。多了两个只在 host 侧有意义的字段：
 * `upstreamKey`（线上请求用的上游 `key`，与公开 id 是两回事）与
 * `source`（`X-Model-Source` 头与 `model_config.source` 的取值）。
 */
export interface QoderModelEntry {
  /** 公开 id：上游 `display_name` 去空白。 */
  id: string
  /** 显示名（上游 `display_name` 原样）。 */
  name: string
  /** 上行请求用的上游 key（`X-Model-Key` 与 `model_config.key`）。 */
  upstreamKey: string
  /** 模型来源（`X-Model-Source`，通常 `system` 或 `custom`；pi-provider stream.ts）。 */
  source: string
  /** 一句话能力描述：思考形态 / 可选档位 / 输入模态 / 上下文窗口。由 {@link describeQoderModel} 生成。 */
  hint: string
  /** 服务该模型的区域。 */
  regions: readonly QoderRegion[]
  /** 该模型是否推理模型（目录 `is_reasoning` / `thinking_config` 存在）；`model_config` 照它填。 */
  reasoning: boolean
  /** 该模型**真实**接受的思考档位梯子；空数组 = 不发任何思考控制字段。 */
  reasoningEfforts: readonly QoderReasoningEffort[]
  /** 思考能否关闭（目录 `thinking_config.disabled` 存在与否）。 */
  thinkingDisableable: boolean
  /** 是否接受 image 输入（目录 `is_vl`）。 */
  supportsImages: boolean
  /** 上下文窗口：`context_config` 里最大的 `token_count`，没有时走区域兜底。 */
  defaultContextWindow: number
  /** 调用方不指定输出上限时的输出上限（目录不报，取文档化上限 131072）。 */
  defaultMaxTokens: number
  /** 上游描述；没有逐字来源时为 null（不编文案）。 */
  description: string | null
}

/** 一行能力去掉 `hint` 的样子：hint 由 {@link withHint} 从其余字段生成，不手写。 */
export type QoderModelFacts = Omit<QoderModelEntry, 'hint'>

/**
 * 给一行能力补上生成的 hint。
 *
 * hint 刻意**不**写进表里的字面量：能力字段要当事实用，而文案是给人看的派生值——
 * 生成让「文案与能力表漂移」在结构上不可能发生（同 step-code 的 withHint）。
 */
function withHint(facts: QoderModelFacts): QoderModelEntry {
  const entry: QoderModelEntry = { ...facts, hint: '' }
  return { ...entry, hint: describeQoderModel(entry) }
}

// ---------------------------------------------------------------------------
// 上游目录的解析
// ---------------------------------------------------------------------------

/**
 * 上游 `/algo/api/v2/model/list` 的一个条目（**任何字段都可能缺失**）。
 *
 * 逐字 pi-provider `catalog.ts` 的 `QoderModelEntry`。`max_input_tokens` 是陈旧的
 * 180K 地板（pi-provider 注释：even for models that accept 1M-token prompts），
 * 所以上下文窗口只信 `context_config` 里最大的 `token_count`。
 */
export interface QoderUpstreamModelRecord {
  key?: unknown
  enable?: unknown
  display_name?: unknown
  max_input_tokens?: unknown
  context_config?: unknown
  is_vl?: unknown
  is_reasoning?: unknown
  thinking_config?: unknown
  source?: unknown
  description?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 上游 `display_name` → 公开模型 id：去掉全部空白字符
 * （逐字 pi-provider `toQoderModelId`：`replace(/\s+/g, "")`）。
 */
export function toQoderModelId(displayName: string | undefined): string {
  return (displayName || 'QoderModel').replace(/\s+/g, '')
}

/** 上游 `context_config` → 上下文窗口：所有选项里最大的 `token_count`（pi-provider `contextWindowFromCatalog`）。 */
export function contextWindowFromRecord(record: QoderUpstreamModelRecord, region: QoderRegion): number {
  const config = record.context_config
  if (isRecord(config)) {
    let advertised = 0
    for (const option of Object.values(config)) {
      if (!isRecord(option)) continue
      const tokens = option.token_count
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > advertised) advertised = tokens
    }
    if (advertised > 0) return Math.round(advertised)
  }
  return QODER_DEFAULT_CONTEXT_WINDOW[region]
}

/** 线路级档位顺序（与 {@link describeQoderModel} 和收敛函数共用一份排名）。 */
const EFFORT_ORDER: ReadonlyMap<string, number> = new Map([
  ['minimal', 1],
  ['low', 2],
  ['medium', 3],
  ['high', 4],
  ['xhigh', 5],
  ['max', 6],
])

/** 上游 effort 名 → 本线路档位名。认不出的档位名被丢弃而不是猜。 */
const QODER_EFFORT_NAMES: ReadonlyMap<string, QoderReasoningEffort> = new Map([
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['xhigh', 'xhigh'],
  ['max', 'max'],
])

/**
 * 上游 `thinking_config` → 本线路的档位梯子。
 *
 * 逐字 pi-provider `buildThinkingLevelMap` 的两种形态：
 *
 * - **effort 形态**：`thinking_config.enabled.efforts` 的键集就是这个模型完整的档位集合
 *   （`none`/关闭值不在这个集合里，它在 `thinking_config.disabled` 里）；
 * - **toggle 形态**：`enabled` 存在但没有 `efforts`——只有开/关，没有档位，
 *   梯子为空而 `thinkingDisableable` 照 `disabled` 是否存在决定。
 *
 * 认不出的档位名被丢弃而不是猜：上游加了一个我们没命名过的档位时，
 * 猜一个近似的会让用户选到模型可能拒绝的值。
 */
export function readQoderThinkingConfig(record: QoderUpstreamModelRecord): {
  efforts: readonly QoderReasoningEffort[]
  thinkingDisableable: boolean
  isReasoning: boolean
} {
  const config = record.thinking_config
  if (!isRecord(config)) {
    return { efforts: [], thinkingDisableable: true, isReasoning: record.is_reasoning === true }
  }
  const disableable = config.disabled !== undefined && config.disabled !== null
  const enabled = isRecord(config.enabled) ? config.enabled : undefined
  if (enabled === undefined) {
    return { efforts: [], thinkingDisableable: disableable, isReasoning: true }
  }
  const rawEfforts = isRecord(enabled.efforts) ? enabled.efforts : undefined
  if (rawEfforts === undefined) {
    // toggle 形态：只有开/关。
    return { efforts: [], thinkingDisableable: disableable, isReasoning: true }
  }
  const efforts: QoderReasoningEffort[] = []
  for (const name of Object.keys(rawEfforts)) {
    const matched = QODER_EFFORT_NAMES.get(name.trim().toLowerCase())
    if (matched !== undefined && !efforts.includes(matched)) efforts.push(matched)
  }
  efforts.sort((a, b) => EFFORT_ORDER.get(a)! - EFFORT_ORDER.get(b)!)
  return { efforts, thinkingDisableable: disableable, isReasoning: true }
}

/**
 * 上游一个条目 → 一行能力。
 *
 * 每一个字段都按「端点说了就用，没说就走兜底」的顺序取值（计划 §4）：
 *
 * - 公开 id：`display_name` 去空白；上行 key：`key`。两者缺一不可——
 *   只有 id 没有 key 的条目发不出请求（`X-Model-Key` 是它的取值），跳过而不是猜。
 * - `enable === false` 的条目跳过：它明说自己不可用。
 * - 上下文窗口：`context_config` 最大 `token_count` → 区域兜底。
 * - 思考：`thinking_config` / `is_reasoning`；输入模态：`is_vl`。
 * - 输出上限：目录不报，取 {@link QODER_MAX_OUTPUT_TOKENS}。
 */
export function entryFromQoderRecord(
  record: QoderUpstreamModelRecord,
  region: QoderRegion,
): QoderModelEntry | null {
  const key = nonEmptyString(record.key)
  const displayName = nonEmptyString(record.display_name)
  if (key === undefined || displayName === undefined) return null
  if (record.enable === false) return null
  const thinking = readQoderThinkingConfig(record)
  const facts: QoderModelFacts = {
    id: toQoderModelId(displayName),
    name: displayName,
    upstreamKey: key,
    source: nonEmptyString(record.source) ?? 'system',
    regions: [region],
    reasoning: thinking.isReasoning,
    reasoningEfforts: thinking.isReasoning ? thinking.efforts : [],
    thinkingDisableable: thinking.thinkingDisableable,
    supportsImages: record.is_vl === true,
    defaultContextWindow: contextWindowFromRecord(record, region),
    defaultMaxTokens: QODER_MAX_OUTPUT_TOKENS,
    description: nonEmptyString(record.description) ?? null,
  }
  return withHint(facts)
}

/**
 * 解析上游 `GET {base}/algo/api/v2/model/list?Encode=1` 的应答。
 *
 * 应答形状 `{ chat: [...] }`（逐字 pi-provider `updateQoderModelsCache` 的读取）。
 * 无 key / 无 display_name / 显式 `enable:false` 的条目被丢弃。
 *
 * @returns 能力行，顺序与上游一致；解析不出任何东西时是空数组。
 */
export function parseQoderModelListing(payload: unknown, region: QoderRegion): QoderModelEntry[] {
  if (!isRecord(payload)) return []
  const list = Array.isArray(payload.chat) ? payload.chat : []
  const entries: QoderModelEntry[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!isRecord(item)) continue
    const entry = entryFromQoderRecord(item, region)
    if (entry === null || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  return entries
}

// ---------------------------------------------------------------------------
// 随包兜底表（照录 pi-provider staticModels / staticCnModels，逐条给出处）
// ---------------------------------------------------------------------------

/** 两个区域都在表里的一行公共形状。 */
interface StaticSeed {
  id: string
  upstreamKey: string
  name: string
  reasoning: boolean
  supportsEffort: boolean
  supportsImages: boolean
  /** 覆盖区域兜底窗口时使用（如 Kimi-K2.7-Code 的 256K）。 */
  contextWindow?: number
}

/**
 * 全球区随包兜底（照录 pi-provider `staticModels`，2026-06 抓取；
 * 档位梯子按 `supportsEffort` 给全档——pi-provider 的 thinkingLevelMap 对 effort
 * 形态逐模型下发，这里随包表没有逐模型数据，给全档并在注释里说明）。
 */
const STATIC_GLOBAL_SEEDS: readonly StaticSeed[] = [
  { id: 'Auto', upstreamKey: 'auto', name: 'Auto', reasoning: true, supportsEffort: false, supportsImages: true },
  { id: 'Ultimate', upstreamKey: 'ultimate', name: 'Ultimate', reasoning: true, supportsEffort: true, supportsImages: true },
  { id: 'Performance', upstreamKey: 'performance', name: 'Performance', reasoning: true, supportsEffort: true, supportsImages: true },
  { id: 'Efficient', upstreamKey: 'efficient', name: 'Efficient', reasoning: false, supportsEffort: false, supportsImages: true },
  { id: 'Lite', upstreamKey: 'lite', name: 'Lite', reasoning: false, supportsEffort: false, supportsImages: false },
  { id: 'Qwen3.7Plus', upstreamKey: 'qmodel', name: 'Qwen3.7 Plus', reasoning: false, supportsEffort: false, supportsImages: true },
  { id: 'Cantus', upstreamKey: 'cmodel', name: 'Cantus', reasoning: true, supportsEffort: true, supportsImages: true },
  { id: 'Qwen3.8-Max', upstreamKey: 'qmodel_preview', name: 'Qwen3.8-Max', reasoning: true, supportsEffort: true, supportsImages: true },
  { id: 'Qwen3.7-Max', upstreamKey: 'qmodel_latest', name: 'Qwen3.7-Max', reasoning: false, supportsEffort: false, supportsImages: true },
  { id: 'DeepSeek-V4-Pro', upstreamKey: 'dmodel', name: 'DeepSeek-V4-Pro', reasoning: true, supportsEffort: true, supportsImages: true },
  { id: 'DeepSeek-V4-Flash', upstreamKey: 'dfmodel', name: 'DeepSeek-V4-Flash', reasoning: true, supportsEffort: true, supportsImages: true },
  { id: 'GLM-5.2', upstreamKey: 'gm51model', name: 'GLM-5.2', reasoning: true, supportsEffort: true, supportsImages: true },
  // 目录对该模型声明 256K（pi-provider 注释：not included in the 1M live test）。
  { id: 'Kimi-K2.7-Code', upstreamKey: 'kmodel', name: 'Kimi-K2.7-Code', reasoning: false, supportsEffort: false, supportsImages: true, contextWindow: 256_000 },
  { id: 'Kimi-K3', upstreamKey: 'kmodel_latest', name: 'Kimi-K3', reasoning: false, supportsEffort: false, supportsImages: true },
  { id: 'MiniMax-M3', upstreamKey: 'mmodel', name: 'MiniMax-M3', reasoning: false, supportsEffort: false, supportsImages: true },
]

/** 中国站随包兜底（照录 pi-provider `staticCnModels`，2026-06 抓取）。 */
const STATIC_CN_SEEDS: readonly StaticSeed[] = [
  // CN Auto 没有在 1M 实测过，保守 200K（pi-provider 注释逐字）。
  { id: 'Auto', upstreamKey: 'auto', name: 'Auto', reasoning: true, supportsEffort: false, supportsImages: true, contextWindow: 200_000 },
  { id: 'Qwen3.7-Max', upstreamKey: 'qmodel_latest', name: 'Qwen3.7-Max', reasoning: true, supportsEffort: false, supportsImages: true },
  { id: 'Qwen3.7-Plus', upstreamKey: 'qmodel', name: 'Qwen3.7-Plus', reasoning: true, supportsEffort: false, supportsImages: false },
  { id: 'Qwen3.6-Flash', upstreamKey: 'q36fmodel', name: 'Qwen3.6-Flash', reasoning: true, supportsEffort: false, supportsImages: false },
  { id: 'DeepSeek-V4-Pro', upstreamKey: 'dmodel', name: 'DeepSeek-V4-Pro', reasoning: true, supportsEffort: false, supportsImages: false },
  { id: 'DeepSeek-V4-Flash', upstreamKey: 'dfmodel', name: 'DeepSeek-V4-Flash', reasoning: false, supportsEffort: false, supportsImages: false },
  // CN 目录当前对 GLM-5.2 显示 200K（pi-provider 注释逐字：do not copy global gm51model's 1M）。
  { id: 'GLM-5.2', upstreamKey: 'gm51model', name: 'GLM-5.2', reasoning: true, supportsEffort: false, supportsImages: true, contextWindow: 200_000 },
  { id: 'Kimi-K2.7-Code', upstreamKey: 'kmodel', name: 'Kimi-K2.7-Code', reasoning: true, supportsEffort: false, supportsImages: true, contextWindow: 256_000 },
  // CN 目录对 mmodel 报 200K（pi-provider 注释逐字）。
  { id: 'MiniMax-M2.7', upstreamKey: 'mmodel', name: 'MiniMax-M2.7', reasoning: false, supportsEffort: false, supportsImages: false, contextWindow: 200_000 },
]

/**
 * 随包表的档位梯子：effort 形态给全档（`low` 到 `max`），toggle 形态给空。
 *
 * ⚠ 这是兜底表的**保守声明**，不是逐模型的端点事实：随包表没有
 * `thinking_config.enabled.efforts` 的逐模型数据，给全档让收敛函数有东西可落；
 * 运行时目录一旦读到，逐模型的真实梯子就顶替这张表（计划 §4）。
 */
const STATIC_EFFORT_LADDER: readonly QoderReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

function seedToEntry(seed: StaticSeed, region: QoderRegion): QoderModelEntry {
  const facts: QoderModelFacts = {
    id: seed.id,
    name: seed.name,
    upstreamKey: seed.upstreamKey,
    source: 'system',
    regions: [region],
    reasoning: seed.reasoning,
    reasoningEfforts: seed.reasoning && seed.supportsEffort ? STATIC_EFFORT_LADDER : [],
    thinkingDisableable: true,
    supportsImages: seed.supportsImages,
    defaultContextWindow: seed.contextWindow ?? QODER_DEFAULT_CONTEXT_WINDOW[region],
    defaultMaxTokens: QODER_MAX_OUTPUT_TOKENS,
    description: null,
  }
  return withHint(facts)
}

/** 随包发布的全球区目录（能力兜底，登录后被运行时目录顶替）。 */
export const QODER_MODEL_CATALOG_GLOBAL: readonly QoderModelEntry[] = STATIC_GLOBAL_SEEDS.map((seed) => seedToEntry(seed, 'global'))

/** 随包发布的中国站目录。 */
export const QODER_MODEL_CATALOG_CN: readonly QoderModelEntry[] = STATIC_CN_SEEDS.map((seed) => seedToEntry(seed, 'cn'))

/** 一个区域的随包兜底表。 */
export function bundledQoderCatalog(region: QoderRegion): readonly QoderModelEntry[] {
  return region === 'cn' ? QODER_MODEL_CATALOG_CN : QODER_MODEL_CATALOG_GLOBAL
}

/** 首次安装默认勾选的模型：空数组 = 不过滤（与 step-code 同一语义，见 token-store 的注释）。 */
export const DEFAULT_VISIBLE_MODEL_IDS: readonly string[] = []

// ---------------------------------------------------------------------------
// 未声明行
// ---------------------------------------------------------------------------

/**
 * 未知模型的**未声明**行。
 *
 * 什么都不主张：`reasoningEfforts: []`（不发思考字段）、`supportsImages: false`
 * （不认图比乱认图安全）、窗口取区域兜底。未声明行**默认可见**：协议面是固定的
 * COSY 对话面，调它是合法的，未知的只是能力（与 step-code 同一决定，与 glm 相反）。
 */
export function undeclaredQoderModelEntry(
  id: string,
  options: { region?: QoderRegion; upstreamKey?: string } = {},
): QoderModelEntry {
  const name = id.trim()
  const region = options.region ?? 'global'
  const facts: QoderModelFacts = {
    id: name,
    name,
    // 公开 id 是 display_name 去空白，上行 key 与它的关系只有目录知道；
    // 未声明行没有目录条目，key 只能按 id 原样发（上游不认就 404，如实报回来）。
    upstreamKey: options.upstreamKey ?? name,
    source: 'system',
    regions: [region],
    reasoning: false,
    reasoningEfforts: [],
    thinkingDisableable: true,
    supportsImages: false,
    defaultContextWindow: QODER_DEFAULT_CONTEXT_WINDOW[region],
    defaultMaxTokens: QODER_MAX_OUTPUT_TOKENS,
    description: null,
  }
  const entry: QoderModelEntry = { ...facts, hint: '' }
  return { ...entry, hint: describeQoderModel(entry, '未声明模型') }
}

/**
 * 查一行模型能力；给定目录里没有时返回**未声明行**而不是 undefined。
 * 先按公开 id 精确匹配，再按上游 key 匹配（请求面拿的是 key），都不中才未声明。
 */
export function resolveQoderModel(
  id: string,
  catalog: readonly QoderModelEntry[],
  region: QoderRegion = 'global',
): QoderModelEntry {
  const wanted = id.trim()
  if (wanted === '') return undeclaredQoderModelEntry(wanted, { region })
  return catalog.find((model) => model.id === wanted)
    ?? catalog.find((model) => model.id.toLowerCase() === wanted.toLowerCase())
    ?? catalog.find((model) => model.upstreamKey === wanted)
    ?? undeclaredQoderModelEntry(wanted, { region })
}

/** 该模型真实接受的思考档位；不在目录里时是空数组（即「不发任何思考控制字段」）。 */
export function qoderReasoningEfforts(
  id: string,
  catalog: readonly QoderModelEntry[],
): readonly QoderReasoningEffort[] {
  return resolveQoderModel(id, catalog).reasoningEfforts
}

/** 该模型的输出上限；不在目录里时取 {@link QODER_MAX_OUTPUT_TOKENS}。 */
export function maxOutputTokensFor(id: string, catalog: readonly QoderModelEntry[]): number {
  return resolveQoderModel(id, catalog).defaultMaxTokens
}

/** 该模型的上下文窗口；不在目录里时取区域兜底。 */
export function defaultContextWindowFor(
  id: string,
  catalog: readonly QoderModelEntry[],
  region: QoderRegion = 'global',
): number {
  return resolveQoderModel(id, catalog, region).defaultContextWindow
}

/** 目录里的全部公开 id。 */
export function listModelIds(catalog: readonly QoderModelEntry[]): string[] {
  return catalog.map((model) => model.id)
}

/** 目录条目数，供 hub 概览显示「M 个模型可用」。 */
export function catalogSize(catalog: readonly QoderModelEntry[]): number {
  return catalog.length
}

/** {@link catalogSize} 的别名（与兄弟线路的调用形状一致）。 */
export const catalogTotal = catalogSize

/**
 * 从一行能力生成设置卡上的一句话描述（四个要素：思考形态 / 档位 / 输入模态 / 上下文窗口）。
 *
 * 由数据生成而不是逐行手写，是为了让文案**不可能与能力表漂移**（同 step-code 的
 * describeStepCodeModel，连理由都同源）。
 */
export function describeQoderModel(entry: QoderModelEntry, prefix?: string): string {
  const thinking = entry.reasoningEfforts.length === 0
    ? (entry.thinkingDisableable ? '思考可开关' : '思考恒开')
    : (entry.thinkingDisableable ? '思考可关闭' : '思考恒开')
  const effort = entry.reasoningEfforts.length === 0
    ? '无档位字段'
    : '档位 ' + entry.reasoningEfforts.join('/')
  const modality = entry.supportsImages ? '输入 text + image' : '输入仅 text'
  const head = prefix === undefined || prefix === '' ? '' : prefix + '：'
  return head + [thinking, effort, modality, '上下文 ' + entry.defaultContextWindow].join('｜')
}

// ---------------------------------------------------------------------------
// 目录 + 用户设置 → 设置面下发
// ---------------------------------------------------------------------------

/** 用户设置对目录装配的两处覆盖。 */
export interface QoderCatalogOptionOverrides {
  /**
   * 用户勾选的模型 id。
   *
   * **缺省或空数组 = 不过滤（全选）**；非空 = 显式选择（含只有一项）。
   * 语义逐字照抄 step-code：schemastery 会把缺省的 `z.array(z.string())` 归一化成 `[]`，
   * 所以没有「null = 不过滤」的第三态。真要把模型全关，关线路总开关是明确且语义正确的动作。
   */
  enabledModelIds?: readonly string[]
  /** 逐模型上下文窗口覆盖；null / 非正数表示用目录默认值。 */
  contextWindowOverrides?: Readonly<Record<string, number | null | undefined>>
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

/**
 * 把目录装配成设置面的模型行。
 *
 * `hint` 在这里生成（而不是写死在表里），所以「文案与能力表一致」是结构保证的。
 * 未声明行**默认可见**（见 {@link undeclaredQoderModelEntry}）。
 */
export function catalogModelOptions(
  catalog: readonly QoderModelEntry[],
  overrides: QoderCatalogOptionOverrides = {},
): QoderModelOption[] {
  const selected = overrides.enabledModelIds
  const noFilter = selected === undefined || selected.length === 0
  return catalog.map((entry) => {
    const override = overrides.contextWindowOverrides?.[entry.id]
    const contextWindow = positiveInt(override) ?? entry.defaultContextWindow
    return {
      id: entry.id,
      name: entry.name,
      hint: entry.hint === '' ? describeQoderModel(entry) : entry.hint,
      enabled: noFilter || selected.includes(entry.id),
      defaultContextWindow: entry.defaultContextWindow,
      contextWindow,
      defaultMaxTokens: entry.defaultMaxTokens,
      reasoningEfforts: entry.reasoningEfforts,
      thinkingDisableable: entry.thinkingDisableable,
      supportsImages: entry.supportsImages,
      regions: entry.regions,
      description: entry.description,
    }
  })
}
