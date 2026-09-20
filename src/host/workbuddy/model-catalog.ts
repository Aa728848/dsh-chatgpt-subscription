/**
 * Model catalog for the WorkBuddy / CodeBuddy subscription.
 *
 * The subscription exposes no `/v1/models`-style listing on the chat host
 * (that path answers 404), but the gateway does publish an **authoritative
 * catalog** at `GET /v3/config`, which the official CLI reads at startup. That
 * payload carries each model's real context window, output cap, image support,
 * and the exact reasoning ladder it accepts — so this route prefers the live
 * catalog and keeps the table below only as an offline fallback.
 *
 * The fallback is a verbatim transcription of a live `/v3/config` read, not
 * hand-written guesses: an earlier revision of this file guessed context
 * windows from vendor marketing and was wrong in both directions (`glm-5.3`
 * and `kimi-k3` are 1M, not 200K/256K). Where the two regions disagree, the
 * larger maximum is kept while the served default comes from whichever region
 * reported one.
 *
 * `regions` is a routing fact, not a preference: asking a region for a model it
 * does not serve answers 400 `code 11102`.
 *
 * A second `code 11102` source was measured and is deliberately NOT filtered
 * out here: the gateway lists models the *current account* is not entitled to
 * call (on a free plan, `glm-5.0`, `glm-4.7`, `glm-4.6`, `glm-4.6v`,
 * `kimi-k2-thinking`, `hy4-preview-x` and `minimax-m2.5` all advertise a context
 * window and then answer 11102). Those entries are kept because the gating is
 * per-account, not per-model — a paid plan may serve them — and because the
 * shipped default selection excludes them anyway. The adapter's failure message
 * names this case so a user knows to pick another model rather than to retry.
 *
 * `reasoningEfforts` carries the ladder a model accepts, transcribed from the
 * gateway's own declaration. `/v3/config` uses two shapes and they were once
 * conflated, in opposite directions: a lone `{ effort: 'high' }` (no
 * `supportedEfforts`) first became a one-entry ladder, which rejected a
 * caller's explicit `low`; widening it to every level this route can name then
 * advertised `minimal`/`xhigh` on a model that has three. Such a model accepts
 * exactly `low`/`high`/`max` (measured on `deepseek-v4.1-flash`), the same
 * three the gateway declares explicitly for `glm-5.3-flash` and
 * `kimi-k2.8-preview`, and routes any other value into the nearest of them.
 */

import type { WorkBuddyRegion } from '../../shared/workbuddy-contracts.ts'
import { DEFAULT_CONTEXT_WINDOW, FALLBACK_MAX_TOKENS } from './types.ts'
import { convergeWorkBuddyEffort } from '../../shared/workbuddy-contracts.ts'

export interface WorkBuddyModelEntry {
  id: string
  name: string
  /**
   * Context length the gateway serves **by default** for this model.
   *
   * This route sends no explicit context-length parameter, so this is the
   * figure DSH's compaction and overflow decisions must use. It is not always
   * the model's maximum: the gateway reports both (for example
   * `deepseek-v4.1-flash` serves 300000 by default and allows 1000000).
   */
  contextWindow: number
  /** Largest context length the model accepts when one is requested. */
  maxContextWindow: number
  /** Output cap requested when the caller omits one. */
  maxTokens: number
  /** Regions whose backend serves this id. */
  regions: readonly WorkBuddyRegion[]
  /** Whether the model accepts image input. */
  supportsImage: boolean
  /** Reasoning ladder the model accepts; empty for a non-reasoning model. */
  reasoningEfforts: readonly string[]
  /** Level this route selects when the caller names none. */
  defaultReasoningEffort: string | null
  /** Whether the model can be asked to skip thinking entirely. */
  canDisableThinking: boolean
  /** One-line note shown beside the model in the settings card. */
  description: string
}

/**
 * Offline fallback catalog, transcribed from a live `/v3/config` read.
 *
 * Used when the gateway cannot be reached (first run before sign-in, or a
 * network failure); a reachable gateway always wins.
 */
export const FALLBACK_MODELS: readonly WorkBuddyModelEntry[] = [
  {
    id: 'default-model',
    name: 'Auto',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 24000,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '优秀的编码模型，适合日常使用',
  },
  {
    id: 'default',
    name: 'Default',
    contextWindow: 56000,
    maxContextWindow: 56000,
    maxTokens: 24000,
    regions: ['cn'],
    supportsImage: false,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'fast-model',
    name: 'Fast',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 32000,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    canDisableThinking: false,
    description: '响应快，适合简单任务',
  },
  {
    id: 'balanced-model',
    name: 'Balanced',
    contextWindow: 256000,
    maxContextWindow: 256000,
    maxTokens: 32000,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    canDisableThinking: false,
    description: '速度与质量兼顾，日常工作首选',
  },
  {
    id: 'primary-model',
    name: 'Primary',
    contextWindow: 272000,
    maxContextWindow: 272000,
    maxTokens: 72000,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '高质量输出，胜任复杂任务',
  },
  {
    id: 'deep-model',
    name: 'Deep',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 24000,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '深度推理，适合深度分析与难题',
  },
  {
    id: 'gpt-6-astra',
    name: 'GPT-6-Astra',
    contextWindow: 400000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: true,
    description: 'OpenAI 旗舰模型，擅长复杂推理与长程任务',
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: true,
    description: 'OpenAI 旗舰模型，擅长复杂推理与长程任务',
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6-Terra',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: true,
    description: 'OpenAI 均衡模型，兼顾能力、速度与成本',
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6-Luna',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: true,
    description: 'OpenAI 轻量模型，响应快速，适合日常任务',
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: 'OpenAI 旗舰编码模型，擅长长程任务',
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    contextWindow: 272000,
    maxContextWindow: 272000,
    maxTokens: 72000,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: 'OpenAI 旗舰编码模型，擅长长程任务',
  },
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 64000,
    regions: ['intl', 'cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: true,
    description: '能力均衡，适合日常使用',
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 32000,
    regions: ['cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: true,
    description: '原生多模态模型，擅长视觉理解与专业任务',
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 64000,
    regions: ['intl', 'cn'],
    supportsImage: true,
    reasoningEfforts: ['high', 'xhigh'],
    defaultReasoningEffort: 'high',
    canDisableThinking: true,
    description: '1M 上下文，擅长长程任务',
  },
  {
    id: 'glm-5.1',
    name: 'GLM-5.1',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 48000,
    regions: ['cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'glm-5v-turbo',
    name: 'GLM-5v-Turbo',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 64000,
    regions: ['cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'glm-5.0',
    name: 'GLM-5.0',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 48000,
    regions: ['cn'],
    supportsImage: false,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'glm-5.0-turbo',
    name: 'GLM-5.0-Turbo',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 48000,
    regions: ['cn'],
    supportsImage: false,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'glm-4.7',
    name: 'GLM-4.7',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 48000,
    regions: ['cn'],
    supportsImage: false,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'glm-4.6v',
    name: 'GLM-4.6V',
    contextWindow: 128000,
    maxContextWindow: 128000,
    maxTokens: 32000,
    regions: ['cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'glm-4.6',
    name: 'GLM-4.6',
    contextWindow: 168000,
    maxContextWindow: 168000,
    maxTokens: 32000,
    regions: ['cn'],
    supportsImage: false,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'kimi-k3',
    name: 'Kimi-K3',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 32000,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    canDisableThinking: false,
    description: '擅长处理复杂的长程自主任务，前端开发能力突出，同时在知识工作与科研推理上表现出色。',
  },
  {
    id: 'kimi-k3-1',
    name: 'Kimi-K3',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 32000,
    regions: ['cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    canDisableThinking: false,
    description: '擅长处理复杂的长程自主任务，前端开发能力突出，同时在知识工作与科研推理上表现出色。',
  },
  {
    id: 'kimi-k2.8-preview',
    name: 'Kimi-K2.8-Preview',
    contextWindow: 300000,
    maxContextWindow: 1000000,
    maxTokens: 64000,
    regions: ['intl', 'cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: true,
    description: '擅长处理复杂的长程自主任务，前端开发能力突出，同时在知识工作与科研推理上表现出色。',
  },
  {
    id: 'kimi-k2.7',
    name: 'Kimi-K2.7-Code',
    contextWindow: 256000,
    maxContextWindow: 256000,
    maxTokens: 32000,
    regions: ['cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'kimi-k2.6',
    name: 'Kimi-K2.6',
    contextWindow: 256000,
    maxContextWindow: 256000,
    maxTokens: 32000,
    regions: ['intl', 'cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    canDisableThinking: false,
    description: '多模态模型，适合日常任务',
  },
  {
    id: 'kimi-k2.5',
    name: 'Kimi-K2.5',
    contextWindow: 164000,
    maxContextWindow: 164000,
    maxTokens: 32000,
    regions: ['cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'kimi-k2-thinking',
    name: 'Kimi-K2-Thinking',
    contextWindow: 164000,
    maxContextWindow: 164000,
    maxTokens: 32000,
    regions: ['cn'],
    supportsImage: false,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'deepseek-v4.1-flash',
    name: 'Deepseek-V4.1-Flash',
    contextWindow: 300000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl', 'cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: 'DeepSeek 旗舰模型，支持 1M 上下文窗口，原生多模态',
  },
  {
    id: 'deepseek-v4.1-flash-sg',
    name: 'Deepseek-V4.1-Flash',
    contextWindow: 300000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: 'DeepSeek 旗舰模型，支持 1M 上下文窗口，原生多模态',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'Deepseek-V4-Pro',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'deepseek-v4-flash',
    name: 'Deepseek-V4-Flash',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 50000,
    regions: ['cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'deepseek-v3-2-volc',
    name: 'DeepSeek-V3.2',
    contextWindow: 96000,
    maxContextWindow: 96000,
    maxTokens: 32000,
    regions: ['cn'],
    supportsImage: false,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'hy4-preview',
    name: 'Hy4 preview',
    contextWindow: 200000,
    maxContextWindow: 1000000,
    maxTokens: 64000,
    regions: ['intl', 'cn'],
    supportsImage: true,
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '混元思考模型，具有增强的推理能力',
  },
  {
    id: 'hy4-preview-x',
    name: 'Hy4 preview',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 64000,
    regions: ['cn'],
    supportsImage: true,
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '混元思考模型，具有增强的推理能力',
  },
  {
    id: 'hy3',
    name: 'Hy3',
    contextWindow: 192000,
    maxContextWindow: 192000,
    maxTokens: 64000,
    regions: ['intl', 'cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '混元思考模型，具有增强的推理能力',
  },
  {
    id: 'hy3-x',
    name: 'Hy3',
    contextWindow: 192000,
    maxContextWindow: 192000,
    maxTokens: 64000,
    regions: ['cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '混元思考模型，具有增强的推理能力',
  },
  {
    id: 'hunyuan-chat',
    name: 'Hunyuan-Turbos',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 8192,
    regions: ['cn'],
    supportsImage: false,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'minimax-m3',
    name: 'MiniMax-M3',
    contextWindow: 512000,
    maxContextWindow: 512000,
    maxTokens: 64000,
    regions: ['cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    canDisableThinking: false,
    description: '原生多模态，擅长代码、智能体任务',
  },
  {
    id: 'minimax-m2.7',
    name: 'MiniMax-M2.7',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 48000,
    regions: ['cn'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'minimax-m2.5',
    name: 'MiniMax-M2.5',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 48000,
    regions: ['cn'],
    supportsImage: false,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini-3.5-Flash',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 65536,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    canDisableThinking: false,
    description: '能力均衡，适合日常使用',
  },
]

/**
 * Models the picker offers on a fresh install.
 *
 * Deliberately short: the catalog holds every id the subscription serves, and
 * the picker is far more usable with the handful of general-purpose models. The
 * card lets a user add the rest, and a first-run default expands to everything
 * the account's region can actually call.
 */
export const DEFAULT_VISIBLE_MODEL_IDS: readonly string[] = [
  'glm-5.3',
  'deepseek-v4.1-flash',
  'hy4-preview',
  'kimi-k2.6',
]

/** Every id the fallback knows, in declaration order. */
export const WORKBUDDY_MODEL_IDS: readonly string[] = FALLBACK_MODELS.map((model) => model.id)

/**
 * Resolve one entry from a catalog.
 *
 * An unknown id resolves to a synthetic text-only entry rather than the first
 * catalog row: reporting a real model's capabilities for an id it does not
 * describe would mis-declare image support and route a request to a 400.
 */
export function resolveWorkBuddyModel(
  id: string,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): WorkBuddyModelEntry {
  const found = catalog.find((model) => model.id === id)
  if (found !== undefined) {
    // Normalize on read rather than editing the transcribed table: the gateway
    // names a default from a wider vocabulary than the ladder it publishes for
    // the same model (`medium` for entries that expose only `low`/`high`/`max`).
    // Left as-is, that value is dropped by the level-resolution step, no
    // `reasoning_effort` is sent, and the model returns empty reasoning.
    const ladder = found.reasoningEfforts
    const declared = found.defaultReasoningEffort
    if (declared === null || ladder.includes(declared)) return found
    return { ...found, defaultReasoningEffort: convergeWorkBuddyEffort(declared, ladder) }
  }
  return {
    id,
    name: id,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxContextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: FALLBACK_MAX_TOKENS,
    regions: ['cn', 'intl'],
    supportsImage: false,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '',
  }
}

/** Whether one catalog knows this exact id. */
export function isWorkBuddyModelId(
  id: unknown,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): id is string {
  return typeof id === 'string' && catalog.some((model) => model.id === id)
}

/** Models an account in `region` can actually call, in catalog order. */
export function modelsForRegion(
  region: WorkBuddyRegion,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): WorkBuddyModelEntry[] {
  return catalog.filter((model) => model.regions.includes(region))
}

/** Whether one model accepts image input. */
export function workBuddyModelSupportsImage(
  id: string,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): boolean {
  return resolveWorkBuddyModel(id, catalog).supportsImage
}

/** Reasoning ladder one model accepts. */
export function workBuddyReasoningEfforts(
  id: string,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): readonly string[] {
  return resolveWorkBuddyModel(id, catalog).reasoningEfforts
}

/** Output cap requested when the caller omits one. */
export function maxOutputTokensFor(
  id: string,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): number {
  return resolveWorkBuddyModel(id, catalog).maxTokens || FALLBACK_MAX_TOKENS
}

/** Context window assumed when no override is saved. */
export function defaultContextWindowFor(
  id: string,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): number {
  return resolveWorkBuddyModel(id, catalog).contextWindow || DEFAULT_CONTEXT_WINDOW
}
