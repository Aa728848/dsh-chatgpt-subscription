/**
 * Static catalog of the models the Kimi Code subscription serves.
 *
 * Transcribed from the official model table at
 * https://www.kimi.com/code/docs/en/kimi-code/models.html. Model version names
 * (K3, K2.8 Preview) are NOT valid request ids: only the ids below may appear in
 * a request body, or the service answers 401 "Your model id does not exist".
 */

import type { KimiCodeReasoningEffort } from '../../shared/kimi-code-contracts.ts'

/** One model the Kimi Code endpoint serves to subscription accounts. */
export interface KimiCodeCatalogModel {
  /** Exact model id to put on the wire. */
  id: string
  /** Display name shown in the picker. */
  name: string
  /** Marketing version the id maps to, e.g. K3. */
  version: string
  /**
   * Context window used unless the user overrides it.
   *
   * For `k3` this is deliberately the Moderato-tier 256K bound rather than the
   * 1M the model can reach: the server rejects a request that exceeds the
   * signed-in plan's entitlement with a 401, so a session that silently grew
   * past 256K on a Moderato account would fail hard instead of compacting.
   * Allegretto-and-above users raise it with the context-window override.
   */
  contextWindow: number
  /** Context the highest tier unlocks, when it is larger than {@link contextWindow}. */
  maxContextWindow: number | null
  /** Output cap requested when the caller omits one. */
  maxTokens: number
  /** Input the model accepts; DSH only maps the text and image entries. */
  inputModalities: readonly ('text' | 'image' | 'video')[]
  /** Thinking levels the model accepts, in escalating order. */
  reasoningEfforts: readonly KimiCodeReasoningEffort[]
  /** Thinking level used when the conversation does not pick one. */
  defaultReasoningEffort: KimiCodeReasoningEffort | null
  /** Subscription tier needed for the full model, when not every member has it. */
  minimumPlan: string | null
  /** Subscription tier needed for the full context window, when it differs. */
  contextPlan: string | null
  /** One-line description from the official table. */
  description: string
  /** Relative quota cost of this model against the cheapest one. */
  quotaMultiplier: number
  /** How fast the model emits output. */
  speed: 'regular' | 'highspeed'
}

/**
 * The four ids the subscription serves today.
 *
 * `kimi-for-coding` is the alias that never changes: Moonshot upgrades the model
 * behind it in place (K2.7 Code became K2.8 Preview without a config change), so
 * this entry is the durable default a user can leave selected.
 */
export const KIMI_CODE_MODELS: readonly KimiCodeCatalogModel[] = [
  {
    id: 'k3',
    name: 'K3',
    version: 'K3',
    contextWindow: 262_144,
    maxContextWindow: 1_048_576,
    maxTokens: 32_768,
    inputModalities: ['text', 'image', 'video'],
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    minimumPlan: 'Moderato',
    contextPlan: 'Allegretto',
    description: 'The most capable flagship coding model: 2.8T parameters, 1M context window. The 1M context consumes about twice the quota of k3-256k.',
    quotaMultiplier: 2,
    speed: 'regular',
  },
  {
    id: 'k3-256k',
    name: 'K3 (256K)',
    version: 'K3',
    contextWindow: 262_144,
    maxContextWindow: null,
    maxTokens: 32_768,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    minimumPlan: 'Moderato',
    contextPlan: null,
    description: 'The 256K context version of K3, available to every Moderato member and above. Costs about half the quota of k3 with 1M context, and does not accept video input.',
    quotaMultiplier: 1,
    speed: 'regular',
  },
  {
    id: 'kimi-for-coding',
    name: 'Kimi for Coding',
    version: 'K2.8 Preview',
    contextWindow: 1_048_576,
    maxContextWindow: null,
    maxTokens: 32_768,
    inputModalities: ['text', 'image', 'video'],
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'max',
    minimumPlan: null,
    contextPlan: null,
    description: 'Performance close to K3 with more efficient thinking, and up to 1M context on every plan. Good at code completion and routine development tasks.',
    quotaMultiplier: 1,
    speed: 'regular',
  },
  {
    id: 'kimi-for-coding-highspeed',
    name: 'Kimi for Coding HighSpeed',
    version: 'K2.7 Code HighSpeed',
    contextWindow: 262_144,
    maxContextWindow: null,
    maxTokens: 32_768,
    inputModalities: ['text', 'image', 'video'],
    // The table states "Thinking: ON" with no selectable level, so the only
    // honest exposure is the always-on default; sending low/none would ask for
    // behaviour the model does not document.
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    minimumPlan: 'Allegretto',
    contextPlan: null,
    description: 'The high-speed version of K2.7 Code with the same coding ability and roughly 5-6x faster output, at 3x quota usage. Requires the Allegretto plan or above.',
    quotaMultiplier: 3,
    speed: 'highspeed',
  },
]

const BY_ID = new Map(KIMI_CODE_MODELS.map((model) => [model.id, model]))

/** Registry entry for one model id, or undefined when the id is unknown. */
export function kimiCodeModelDef(modelId: string): KimiCodeCatalogModel | undefined {
  return BY_ID.get(modelId.trim())
}

/** Membership test for one known model id. */
export function isKimiCodeModelId(value: unknown): boolean {
  return typeof value === 'string' && BY_ID.has(value.trim())
}

/** Display name for one model id, falling back to the raw id so nothing is hidden. */
export function kimiCodeModelName(modelId: string): string {
  return BY_ID.get(modelId.trim())?.name ?? modelId
}
