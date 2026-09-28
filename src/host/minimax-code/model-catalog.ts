/**
 * Hardcoded catalog of the models the MiniMax Code subscription serves.
 *
 * This catalog is hardcoded on purpose. The endpoint documents a
 * `GET /v1/models` route, but it is not configured for subscription traffic and
 * answers 503 `{"errorCode":50115,"errorReason":"direct_route_not_configured"}`
 * (and 401 when queried with `x-api-key`). Nothing in this package may probe it,
 * at startup or otherwise.
 *
 * The four entries and every number in them are transcribed verbatim from the
 * model table in `~/.minimax/config.yaml` (brief section 2.3). No value here is
 * inferred from another provider's catalog.
 */

import type { MinimaxCodeReasoningEffort } from '../../shared/minimax-code-contracts.ts'

/**
 * How one model's thinking behaves.
 *
 * - `always-on`    — thinking cannot be turned off and has no selectable level;
 * - `toggle`       — thinking is on by default and can be disabled;
 * - `forced-effort` — thinking is forced on and a level can be selected.
 */
export type MinimaxCodeThinkingMode = 'always-on' | 'toggle' | 'forced-effort'

/** One model the MiniMax Code subscription serves. */
export interface MinimaxCodeCatalogModel {
  /** Exact model id to put on the wire. */
  id: string
  /** Display name shown in the picker. */
  name: string
  /** Context window the account is entitled to by default. */
  contextWindow: number
  /** Larger window the model can reach, when one is offered as an option. */
  optionalContextWindow: number | null
  /** Output cap the model accepts. */
  maxTokens: number
  /** Input the model accepts. */
  inputModalities: readonly ('text' | 'image' | 'video')[]
  /** How thinking behaves on this model. */
  thinking: MinimaxCodeThinkingMode
  /**
   * Levels the model accepts, in escalating order.
   *
   * A single `default` entry means the model has no selectable level: the picker
   * shows one always-on option rather than inventing a gradient the model does
   * not document.
   */
  reasoningEfforts: readonly MinimaxCodeReasoningEffort[]
  /** Level used when the conversation does not pick one. */
  defaultReasoningEffort: MinimaxCodeReasoningEffort
  /** Attachments one request may carry, when the model states a bound. */
  maxAttachments: number | null
  /** Largest single image the model accepts, in bytes. */
  maxImageBytes: number | null
  /** Largest single video the model accepts, in bytes. */
  maxVideoBytes: number | null
  /** Whether the model is served through the subscription's files API. */
  supportsFilesApi: boolean
  /** One-line description, from the model table. */
  description: string
}

/**
 * The four ids the subscription serves today.
 *
 * `MiniMax-M3` is the durable default: it is the flagship the measured request
 * used, and it is the one model whose wire behaviour is directly attested.
 */
export const MINIMAX_CODE_MODELS: readonly MinimaxCodeCatalogModel[] = [
  {
    id: 'MiniMax-M2.7',
    name: 'MiniMax M2.7',
    contextWindow: 200_000,
    optionalContextWindow: null,
    maxTokens: 128_000,
    inputModalities: ['text'],
    thinking: 'always-on',
    reasoningEfforts: ['default'],
    defaultReasoningEffort: 'default',
    maxAttachments: null,
    maxImageBytes: null,
    maxVideoBytes: null,
    supportsFilesApi: false,
    description: 'Thinking is always on and has no selectable level. Text input only.',
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    name: 'MiniMax M2.7 HighSpeed',
    contextWindow: 200_000,
    optionalContextWindow: null,
    maxTokens: 128_000,
    inputModalities: ['text'],
    thinking: 'always-on',
    reasoningEfforts: ['default'],
    defaultReasoningEffort: 'default',
    maxAttachments: null,
    maxImageBytes: null,
    maxVideoBytes: null,
    supportsFilesApi: false,
    description: 'The high-speed M2.7. Thinking is always on with no selectable level. Text input only.',
  },
  {
    id: 'MiniMax-M3',
    name: 'MiniMax M3',
    contextWindow: 512_000,
    optionalContextWindow: 1_000_000,
    maxTokens: 128_000,
    inputModalities: ['text', 'image', 'video'],
    thinking: 'toggle',
    // The model's thinking is a two-state switch, not a gradient: the table names
    // it "none-thinking / thinking, default thinking". Exposing one always-on
    // entry is the honest projection of that
    // into DSH's effort list, which has no "off" member.
    reasoningEfforts: ['default'],
    defaultReasoningEffort: 'default',
    maxAttachments: 9,
    maxImageBytes: 10 * 1024 * 1024,
    maxVideoBytes: 50 * 1024 * 1024,
    supportsFilesApi: true,
    description: 'Flagship subscription model. Thinking is on by default and can be disabled. Accepts text, image and video; up to 9 attachments, 10MB per image and 50MB per video.',
  },
  {
    id: 'MiniMax-M3.1-Flash-Preview',
    name: 'MiniMax M3.1 Flash Preview',
    contextWindow: 1_000_000,
    optionalContextWindow: null,
    maxTokens: 128_000,
    inputModalities: ['text', 'image', 'video'],
    thinking: 'forced-effort',
    reasoningEfforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'default',
    maxAttachments: 4,
    maxImageBytes: 10 * 1024 * 1024,
    maxVideoBytes: 50 * 1024 * 1024,
    supportsFilesApi: true,
    description: 'Preview Flash model with a 1M context window. Thinking is forced on with a selectable effort level. Accepts up to 4 attachments.',
  },
]

const BY_ID = new Map(MINIMAX_CODE_MODELS.map((model) => [model.id, model]))

/** Registry entry for one model id, or undefined when the id is unknown. */
export function minimaxCodeModelDef(modelId: string): MinimaxCodeCatalogModel | undefined {
  return BY_ID.get(modelId.trim())
}

/** Membership test for one known model id. */
export function isMinimaxCodeModelId(value: unknown): boolean {
  return typeof value === 'string' && BY_ID.has(value.trim())
}

/** Display name for one model id, falling back to the raw id so nothing is hidden. */
export function minimaxCodeModelName(modelId: string): string {
  return BY_ID.get(modelId.trim())?.name ?? modelId
}

/** Every model id the picker offers, in catalog order. */
export function minimaxCodeModelIds(): string[] {
  return MINIMAX_CODE_MODELS.map((model) => model.id)
}

/**
 * Whether one effort id means "thinking off".
 *
 * The subscription table spells the disabled state "none-thinking" while the
 * shared contract's effort vocabulary has no such member, so a caller that
 * nevertheless asks for an off state (an older preference file, a hand-built
 * request) is recognized here rather than silently treated as "on".
 */
export function isThinkingDisabledEffort(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === 'none' || normalized === 'off' || normalized === 'disabled' || normalized === 'no-thinking'
}

/**
 * The effort level to put on the wire for one model.
 *
 * An unknown or off value falls back to the model's documented default, so a
 * caller cannot talk this route into a level the model does not list.
 */
export function effortForModel(
  modelId: string,
  requested: string | undefined | null,
): MinimaxCodeReasoningEffort {
  const model = minimaxCodeModelDef(modelId)
  if (model === undefined) return 'default'
  if (requested === undefined || requested === null) return model.defaultReasoningEffort
  const normalized = requested.trim().toLowerCase()
  const match = model.reasoningEfforts.find((effort) => effort === normalized)
  return match ?? model.defaultReasoningEffort
}
