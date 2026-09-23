/**
 * Model capabilities for the GLM Coding Plan, transcribed per model.
 *
 * The runtime authority is the plan's own `/api/coding/paas/v4/models` listing,
 * which reports each model's real context window; this table stands in before
 * the first successful fetch and for a machine that cannot reach it yet.
 *
 * Nothing here is inferred from a model's name. Image support and the accepted
 * reasoning ladder are per-model facts that the family name does not decide:
 * `glm-5.3-flash` takes images while `glm-5.3` does not, and `glm-5.2` accepts
 * two effort levels where `glm-5.3` accepts three.
 *
 * Sources, checked 2026-09 against the provider's published specification:
 * - the Coding Plan model registry (`zai-coding-plan` on models.dev), which
 *   lists exactly the models the plan's own base URL serves;
 * - the model pages and core-parameter table on docs.z.ai, which give the
 *   1M-token window and 128K output cap of the GLM-5.x family;
 * - the deep-thinking guide, which states that GLM-5.3 / GLM-5.3-FLASH / GLM-4.7
 *   no longer accept `thinking.type: "disabled"`.
 */

import type { ZhipuRegion } from '../../shared/zhipu-contracts.ts'
import { CODING_EFFORTS } from './types.ts'

/** One model's shipped capability entry. */
export interface ZhipuModelEntry {
  id: string
  name: string
  /** Context window DSH assumes before an override is saved. */
  contextWindow: number
  /** Maximum output tokens this route requests when a caller omits one. */
  maxTokens: number
  /**
   * Reasoning levels this model accepts, in escalating order.
   *
   * Empty means the model takes no `reasoning_effort` at all: it reasons (or
   * does not) by its own default and the field is never sent, because upstream
   * rejects an unsupported level outright.
   */
  reasoningEfforts: readonly string[]
  /** Whether the model accepts image input on this route. */
  supportsImage: boolean
  /**
   * Whether the model can be told to skip thinking.
   *
   * GLM-5.3 / GLM-5.3-FLASH / GLM-4.7 cannot: the provider documents that
   * sending `thinking.type: "disabled"` to them is an error, so this route never
   * sends a disabling value for them.
   */
  canDisableThinking: boolean
  /** Deployments that serve this model. */
  regions: readonly ZhipuRegion[]
  description?: string
}

/** Both deployments serve the plan's model set. */
const BOTH: readonly ZhipuRegion[] = ['intl', 'cn']

/**
 * Output cap of the GLM-5.x family, and the plan's default for it.
 *
 * The provider's parameter table gives a default `max_tokens` of 65536 and a
 * maximum of 131072 for every GLM-5.x entry. DSH asks for the maximum, exactly
 * like the sibling provider lines do: `max_tokens` is a ceiling rather than a
 * reservation, so asking for the cap cannot make a short answer longer.
 */
const GLM5_MAX_OUTPUT = 131_072

/** Output cap of the GLM-4.5 generation. */
const GLM45_MAX_OUTPUT = 98_304

/** Effort ladder of the GLM-5.3 family, exactly as the provider documents it. */
const GLM53_EFFORTS = CODING_EFFORTS

/**
 * Effort ladder of GLM-5.2 under the Coding Plan.
 *
 * The model's own page lists a wider vocabulary (`xhigh`, `medium`, `minimal`,
 * `none`), but states how the plan maps it: `low`/`medium` become `high`,
 * `xhigh` becomes `max`, and `none`/`minimal` stop thinking. So only these two
 * rungs reach the wire as effort levels, which is what this route offers.
 */
const GLM52_EFFORTS = ['high', 'max'] as const

export const ZHIPU_MODELS: readonly ZhipuModelEntry[] = [
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxTokens: GLM5_MAX_OUTPUT,
    reasoningEfforts: GLM53_EFFORTS,
    supportsImage: false,
    // The provider documents that disabling thinking on this model is an error.
    canDisableThinking: false,
    regions: BOTH,
    description: '旗舰模型，1M 上下文，强制思考。',
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 1_000_000,
    maxTokens: GLM5_MAX_OUTPUT,
    reasoningEfforts: GLM53_EFFORTS,
    // The one coding-plan model that takes images on this route.
    supportsImage: true,
    canDisableThinking: false,
    regions: BOTH,
    description: '多模态快速模型，1M 上下文，支持图片输入。',
  },
  {
    id: 'glm-5.3-highspeed',
    name: 'GLM-5.3-Highspeed',
    contextWindow: 1_000_000,
    maxTokens: GLM5_MAX_OUTPUT,
    reasoningEfforts: GLM53_EFFORTS,
    supportsImage: false,
    canDisableThinking: false,
    regions: BOTH,
    description: 'GLM-5.3 高速版，1M 上下文。',
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    contextWindow: 1_000_000,
    maxTokens: GLM5_MAX_OUTPUT,
    reasoningEfforts: GLM52_EFFORTS,
    supportsImage: false,
    // GLM-5.2 is one of the entries that still accepts a disabling value.
    canDisableThinking: true,
    regions: BOTH,
    description: '上一代旗舰，1M 上下文（新套餐会把请求路由到 GLM-5.3）。',
  },
  {
    id: 'glm-5.2-highspeed',
    name: 'GLM-5.2-Highspeed',
    contextWindow: 1_000_000,
    maxTokens: GLM5_MAX_OUTPUT,
    reasoningEfforts: GLM52_EFFORTS,
    supportsImage: false,
    canDisableThinking: true,
    regions: BOTH,
    description: 'GLM-5.2 高速版，1M 上下文。',
  },
  {
    id: 'glm-5-turbo',
    name: 'GLM-5-Turbo',
    contextWindow: 200_000,
    maxTokens: GLM5_MAX_OUTPUT,
    // A toggle-reasoning model: it takes no effort level, so none is sent.
    reasoningEfforts: [],
    supportsImage: false,
    canDisableThinking: true,
    regions: BOTH,
    description: '面向快速推理与 agent 流程的高效模型。',
  },
  {
    id: 'glm-4.7',
    name: 'GLM-4.7',
    contextWindow: 204_800,
    maxTokens: GLM5_MAX_OUTPUT,
    reasoningEfforts: [],
    supportsImage: false,
    canDisableThinking: false,
    regions: BOTH,
    description: '混合推理模型（新套餐会把请求路由到 GLM-5.3-Flash）。',
  },
  {
    id: 'glm-4.5-air',
    name: 'GLM-4.5-Air',
    contextWindow: 131_072,
    maxTokens: GLM45_MAX_OUTPUT,
    reasoningEfforts: [],
    supportsImage: false,
    canDisableThinking: true,
    regions: BOTH,
    description: '轻量模型，适合子代理等高频调用。',
  },
]

/**
 * Which models the shipped table resolves to when the live listing is
 * unreachable. All of them: the table is already the Coding Plan's own model
 * set, and hiding an entry would give the user no way to enable it.
 */
export const DEFAULT_VISIBLE_MODEL_IDS: readonly string[] = ZHIPU_MODELS.map((model) => model.id)

/** The shipped table in the shape the routes and the picker read. */
export const FALLBACK_MODELS: readonly ZhipuModelEntry[] = ZHIPU_MODELS

/** Look one model up, or receive an unknown-model stub that claims nothing. */
export function resolveZhipuModel(modelId: string, catalog: readonly ZhipuModelEntry[] = ZHIPU_MODELS): ZhipuModelEntry {
  const known = catalog.find((model) => model.id === modelId)
  if (known !== undefined) return known
  // An unknown id (a live catalog entry newer than this table) is treated
  // conservatively: text-only, no effort field, and the default window — the
  // same rules the provider API enforces for a capability it has not declared.
  return {
    id: modelId,
    name: modelId,
    contextWindow: 128_000,
    maxTokens: GLM5_MAX_OUTPUT,
    reasoningEfforts: [],
    supportsImage: false,
    canDisableThinking: true,
    regions: BOTH,
  }
}

/** Models one deployment serves. */
export function modelsForRegion(
  region: ZhipuRegion,
  catalog: readonly ZhipuModelEntry[] = ZHIPU_MODELS,
): ZhipuModelEntry[] {
  return catalog.filter((model) => model.regions.includes(region))
}

/** Context window this route assumes for one model, before any override. */
export function defaultContextWindowFor(modelId: string, catalog?: readonly ZhipuModelEntry[]): number {
  return resolveZhipuModel(modelId, catalog ?? ZHIPU_MODELS).contextWindow
}

/** Output cap one request asks for when the caller omits one. */
export function maxOutputTokensFor(modelId: string, catalog?: readonly ZhipuModelEntry[]): number {
  return resolveZhipuModel(modelId, catalog ?? ZHIPU_MODELS).maxTokens
}

/** Reasoning levels one model accepts; empty when it takes no effort field. */
export function zhipuReasoningEfforts(modelId: string, catalog?: readonly ZhipuModelEntry[]): string[] {
  return [...resolveZhipuModel(modelId, catalog ?? ZHIPU_MODELS).reasoningEfforts]
}

/** Whether one model accepts image input on this route. */
export function zhipuModelSupportsImage(modelId: string, catalog?: readonly ZhipuModelEntry[]): boolean {
  return resolveZhipuModel(modelId, catalog ?? ZHIPU_MODELS).supportsImage
}
