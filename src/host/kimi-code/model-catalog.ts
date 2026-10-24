/**
 * Static catalog of the models the Kimi Code subscription serves.
 *
 * Transcribed from the official model table at
 * https://www.kimi.com/code/docs/en/kimi-code/models.html. Model version names
 * (K3, K2.8 Preview) are NOT valid request ids: only the ids below may appear in
 * a request body, or the service answers 401 "Your model id does not exist".
 */

import type { KimiCodeReasoningEffort, KimiCodeThinkingType } from '../../shared/kimi-code-contracts.ts'
import { MAX_MESSAGE_BODY_BYTES } from '../common/request-images.ts'

/**
 * Request-body ceiling the 1M-context tier defaults to.
 *
 * The 2 MB figure this line used to apply to every model comes from the gateway's
 * generic error example and was never measured against a 1M window, while a real
 * 1M session (3-4 MB of Chinese prose) hits it long before the window is full.
 * The official kimi-cli ships no byte guard at all, so the ceiling is this
 * plugin's own safety net rather than a client requirement.
 *
 * 8 MiB is sized so bytes never become the binding limit for a 1M session: that
 * window's body is roughly 4 MB of English or 4.5 MB of dense Chinese, so 8 MiB
 * leaves nearly double the headroom. What binds first is the model's own token
 * window — the service answers "Your request exceeded model token limit", which
 * common/context-overflow.ts already normalizes to CONTEXT_WINDOW_EXCEEDED, so
 * compaction and retry behave exactly as they did before.
 *
 * The number is still an UPPER BOUND pending measurement, not a documented
 * gateway limit: a deployment that has measured its own gateway pins the real
 * figure with DSH_KIMI_CODE_MAX_BODY_BYTES. The 256K tier keeps 2 MB, where the
 * old ceiling and the window line up.
 */
export const LONG_CONTEXT_MESSAGE_BODY_BYTES = 8 * 1024 * 1024

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
  /** Floor for the dynamic wire budget, NOT a ceiling or DSH defaultMaxTokens. */
  maxTokens: number
  /**
   * Local default for the gateway request-body ceiling, graded by context tier.
   *
   * This is the per-model default {@link maxRequestBodyBytesFor} returns when no
   * environment override is set. It is NOT a documented gateway limit: the 1M
   * tier's 8 MiB is a still-unmeasured upper bound (see
   * {@link LONG_CONTEXT_MESSAGE_BODY_BYTES}), and the 256K tier keeps the 2 MiB
   * figure this line applied to every model before the split.
   */
  maxRequestBodyBytes: number
  /** Input the model accepts; DSH only maps the text and image entries. */
  inputModalities: readonly ('text' | 'image' | 'video')[]
  /** Thinking levels the model accepts, in escalating order. */
  reasoningEfforts: readonly KimiCodeReasoningEffort[]
  /** Thinking level used when the conversation does not pick one. */
  defaultReasoningEffort: KimiCodeReasoningEffort | null
  /**
   * How the model handles thinking, when the official table states it.
   *
   * `only` means the model reasons at every level and the service rejects a
   * disabled-thinking request with HTTP 400, so its effort list must never be
   * offered with `none` in it. Absent for every model whose table entry does
   * not say, which is not the same as "can be switched off".
   */
  thinkingType?: KimiCodeThinkingType
  /** Subscription tier needed for the full model, when not every member has it. */
  minimumPlan: string | null
  /** Subscription tier needed for the full context window, when it differs. */
  contextPlan: string | null
  /** One-line description from the official table. */
  description: string
  /**
   * Whether the model accepts message-level tool declarations.
   *
   * Taken from the capability list the official client ships in its own managed
   * model table, which is more specific than the wire documentation (that names
   * K3 alone, because it describes the K3 request schema):
   *
   * - k3, k3-256k, kimi-for-coding -> declared;
   * - kimi-for-coding-highspeed   -> NOT declared.
   *
   * The live `/v1/models` listing remains authoritative when it speaks: its own
   * `supports_dynamic_tools` overrides this flag, including to turn it off.
   */
  supportsDynamicTools: boolean
  /**
   * Relative quota cost of this model against the cheapest one.
   *
   * `null` where the official table publishes no multiplier for the id. The
   * number is never guessed: this field is the only place a user can see why
   * one model spends quota faster than another, so an invented 1x would
   * understate a model that is really 2x or 3x.
   */
  quotaMultiplier: number | null
  /** How fast the model emits output. */
  speed: 'regular' | 'highspeed'
}

/**
 * The ids the subscription serves today.
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
    // 1M tier: the window this id can reach is why the ceiling is raised.
    maxRequestBodyBytes: LONG_CONTEXT_MESSAGE_BODY_BYTES,
    inputModalities: ['text', 'image', 'video'],
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    minimumPlan: 'Moderato',
    contextPlan: 'Allegretto',
    description: 'The most capable flagship coding model: 2.8T parameters, 1M context window. The 1M context consumes about twice the quota of k3-256k.',
    supportsDynamicTools: true,
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
    // 256K tier: no 1M session can fill here, so the old 2 MB ceiling stays.
    maxRequestBodyBytes: MAX_MESSAGE_BODY_BYTES,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    minimumPlan: 'Moderato',
    contextPlan: null,
    description: 'The 256K context version of K3, available to every Moderato member and above. Costs about half the quota of k3 with 1M context, and does not accept video input.',
    supportsDynamicTools: true,
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
    // 1M tier: a full 1M session overruns 2 MB before the window is anywhere
    // near full, so the ceiling tracks the window rather than the generic figure.
    maxRequestBodyBytes: LONG_CONTEXT_MESSAGE_BODY_BYTES,
    inputModalities: ['text', 'image', 'video'],
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'max',
    minimumPlan: null,
    contextPlan: null,
    description: 'Performance close to K3 with more efficient thinking, and up to 1M context on every plan. Good at code completion and routine development tasks.',
    supportsDynamicTools: true,
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
    // 256K tier: the window, not the byte ceiling, is what bounds a session.
    maxRequestBodyBytes: MAX_MESSAGE_BODY_BYTES,
    inputModalities: ['text', 'image', 'video'],
    // The table states "Thinking: ON" with no selectable level, so the only
    // honest exposure is the always-on default; sending low/none would ask for
    // behaviour the model does not document.
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    minimumPlan: 'Allegretto',
    contextPlan: null,
    description: 'The high-speed version of K2.7 Code with the same coding ability and roughly 5-6x faster output, at 3x quota usage. Requires the Allegretto plan or above.',
    supportsDynamicTools: false,
    quotaMultiplier: 3,
    speed: 'highspeed',
  },
  // The K3.1 Pro pair is appended rather than inserted: the rows above are the
  // ids a user already has selected, and their order is what a picker built
  // from this array shows first.
  {
    id: 'k3.1-pro',
    name: 'K3.1 Pro',
    version: 'K3.1 Pro',
    // Same shape as k3 and for the same reason: the published default is the
    // Plus/Moderato 256K bound, and a Moderato session that silently grew to 1M
    // would be refused instead of compacting. That refusal is an account-limit
    // 403 carrying "Your current plan supports only k3.1-pro up to 256K context"
    // (error-reference.html), which is a plan bound rather than a bad request.
    // Pro/Allegretto and above raise it with the context-window override.
    contextWindow: 262_144,
    maxContextWindow: 1_048_576,
    maxTokens: 32_768,
    // 1M tier: same reasoning as k3 — the raised window is what the ceiling
    // follows, and 2 MB would refuse a full 1M session before compaction helps.
    maxRequestBodyBytes: LONG_CONTEXT_MESSAGE_BODY_BYTES,
    inputModalities: ['text', 'image', 'video'],
    reasoningEfforts: ['low', 'high', 'max'],
    // The official table states thinking defaults to max for this family.
    defaultReasoningEffort: 'max',
    // "K3.1 Pro does not support disabled thinking mode" (HTTP 400, see
    // error-reference.html): thinking cannot be turned off, so 'none' is never
    // offered for this id.
    thinkingType: 'only',
    minimumPlan: 'Moderato',
    contextPlan: 'Allegretto',
    description: 'The K3.1 Pro flagship: 3T parameters, a 256K context window on Plus/Moderato and 1M on Pro/Allegretto and above. Thinking runs at low/high/max, defaults to max, and cannot be disabled.',
    supportsDynamicTools: true,
    // UNPUBLISHED: the official pages state no quota multiplier for this id
    // relative to k3-256k, so it is reported as unknown rather than guessed.
    quotaMultiplier: null,
    speed: 'regular',
  },
  {
    id: 'k3.1-pro-highspeed',
    name: 'K3.1 Pro Highspeed',
    version: 'K3.1 Pro Highspeed',
    // 1M is the only context this model is offered with, on Pro/Allegretto and
    // above; there is no smaller tier to fall back to, so no maxContextWindow.
    contextWindow: 1_048_576,
    maxContextWindow: null,
    maxTokens: 32_768,
    // 1M tier: 1M is the only window this id is offered with, so the ceiling
    // has no smaller tier to fall back to.
    maxRequestBodyBytes: LONG_CONTEXT_MESSAGE_BODY_BYTES,
    inputModalities: ['text', 'image', 'video'],
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'max',
    // Same official statement as k3.1-pro: "K3.1 Pro does not support disabled
    // thinking mode" (HTTP 400), so 'none' is never offered for this id either.
    thinkingType: 'only',
    minimumPlan: 'Allegretto',
    contextPlan: null,
    description: 'The high-speed K3.1 Pro with a 1M context window and faster output, at about twice the quota of the regular version. Requires the Pro/Allegretto plan or above.',
    supportsDynamicTools: true,
    // UNPUBLISHED: the only quota statement is the qualitative "about 2x the
    // regular version", which is a comparison inside the K3.1 pair rather than
    // the multiplier-against-the-cheapest-model this field carries. Reported as
    // unknown here and stated in the description instead of being guessed.
    quotaMultiplier: null,
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
