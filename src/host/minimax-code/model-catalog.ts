/**
 * Hardcoded catalog of the models the MiniMax Code subscription serves.
 *
 * This catalog is hardcoded on purpose. The endpoint documents a
 * `GET /v1/models` route, but it is not configured for subscription traffic and
 * answers 503 `{"errorCode":50115,"errorReason":"direct_route_not_configured"}`
 * (and 401 when queried with `x-api-key`). Nothing in this package may probe it,
 * at startup or otherwise.
 *
 * The first three entries and every number in them are transcribed verbatim
 * from the model table in `~/.minimax/config.yaml` (brief section 2.3). The
 * fourth (M3.1 Flash) no longer is: MiniMax published the GA model on its own
 * Model Invocation page and dropped the `-Preview` suffix there, so it is
 * transcribed from that page's Supported Models table and measured on this
 * subscription endpoint on 2026-10-19. No value here is inferred from another
 * provider's catalog.
 */

import type {
  MinimaxCodeModelOption,
  MinimaxCodeReasoningEffort,
  MinimaxCodeThinkingModeDto,
} from '../../shared/minimax-code-contracts.ts'
import { DEFAULT_CONTEXT_WINDOW } from './types.ts'
import { maxOutputTokensFor } from './mapper.ts'

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
  /**
   * Input the model accepts.
   *
   * Declared as the wire accepts it, which is also what this line can put on that
   * wire — a capability listed here is a claim DSH's capability pipeline acts on
   * (prompt admission, the model picker, subagent delegation), so listing
   * something the mapper cannot encode would be a promise the route breaks.
   *
   * Video is now listed for the models that take it. It was not, because the
   * route had no video byte reader; the reader arrived with the shared video
   * request layer (see `../common/video-request.ts` and the Kimi Code line's
   * `video-store.ts`), and a live probe confirmed this endpoint decodes a
   * `{ type: 'video', source: { type: 'base64', ... } }` block.
   *
   * The inline path still tops out well below the documented 50 MB per clip,
   * because base64 grows bytes by 4/3 against a 64 MB request body; the budget is
   * `MAX_REQUEST_VIDEO_BYTES` in ./types.ts, and a longer clip needs the Files
   * API, which this line does not implement.
   */
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
  /**
   * Level used when the conversation does not pick one.
   *
   * Null for a model with no selectable level (an always-on one): there is
   * nothing to put on the wire, and a value here would be a promise the route
   * cannot keep.
   */
  defaultReasoningEffort: MinimaxCodeReasoningEffort | null
  /**
   * Attachments the model's FILES API accepts, when it states a bound.
   *
   * This is the max_attachments_count that ships with the model's file-API
   * capability block, NOT a limit on the inline images this line sends. A live
   * probe of the subscription endpoint served 4, 5, 8, 9, 10, 12, 20 and 48
   * inline images on M3 with HTTP 200, so enforcing this number on the inline
   * path would drop images the service accepts. It is reported because the
   * Files API question is real, and for the same reason as filesApiDocumented:
   * this line uploads nothing.
   */
  maxAttachments: number | null
  /** Largest single image the model accepts, in bytes. */
  maxImageBytes: number | null
  /** Largest single video the model accepts, in bytes. */
  maxVideoBytes: number | null
  /**
   * Whether the subscription documents a files API for this model. Documentation
   * only: the plugin sends every attachment inline and implements no upload, TTL,
   * account isolation or deletion, so this flag never means the Files API is
   * delivered here.
   */
  filesApiDocumented: boolean
  /** One-line description, from the model table. */
  description: string
}

/**
 * The four ids the subscription serves today.
 *
 * `MiniMax-M3` is the durable default: it is the flagship the measured request
 * used, and it is the one model whose wire behaviour is directly attested.
 *
 * The fourth id used to be `MiniMax-M3.1-Flash-Preview`. MiniMax published
 * `MiniMax-M3.1-Flash` (no suffix) and the preview id was measured answering
 * 200 on the same day, so the catalog carries the GA name only. Anything still
 * naming the preview id in a stored selection, a `provider/model` route string
 * or a doc must be rewritten, or it resolves to a model this build has no entry
 * for.
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
    // No level at all: the upstream catalog lists `reasoning_options: []` for the
    // M2.7 family, and the endpoint has no field to set. An always-on model
    // publishes no levels rather than a fake one.
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    maxAttachments: null,
    maxImageBytes: null,
    maxVideoBytes: null,
    filesApiDocumented: false,
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
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    maxAttachments: null,
    maxImageBytes: null,
    maxVideoBytes: null,
    filesApiDocumented: false,
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
    // The upstream catalog (the models.dev snapshot) lists M3 as a pure toggle
    // with no depth levels - but this endpoint MEASURED honours
    // `output_config.effort` on M3: low and max differ by about 3x thinking
    // and 4x latency (2026-10-05, re-measured 2026-10-20). The measurement
    // outranks the catalog, so the levels are exposed.
    //
    // The default is stated out loud rather than left implicit: "omitted" means
    // max on the server, so an unstated level was silently the most expensive
    // one - and with the invented `default` tier in place, a caller asking for
    // `low` was quietly clamped back to it.
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'max',
    maxAttachments: 9,
    maxImageBytes: 10 * 1024 * 1024,
    maxVideoBytes: 50 * 1024 * 1024,
    filesApiDocumented: true,
    description: 'Flagship subscription model. Thinking is on by default and can be disabled. Accepts text, image and video; up to 9 attachments, 10MB per image and 50MB per video.',
  },
  {
    id: 'MiniMax-M3.1-Flash',
    name: 'MiniMax M3.1 Flash',
    contextWindow: 512_000,
    optionalContextWindow: 1_000_000,
    maxTokens: 128_000,
    inputModalities: ['text', 'image', 'video'],
    thinking: 'forced-effort',
    // The documented depth levels, and the default is one of them.
    //
    // `default` is gone from the vocabulary entirely: it was never a wire
    // value (the docs say omitting `effort` means max), and it was never a
    // LEVEL either - listing it here put it at the top of the ladder, where
    // `orderReasoningEfforts` ranked it above `max` and DSH's picker showed
    // it as the strongest thinking level. The upstream models.dev snapshot
    // names no such level for any MiniMax model, and neither does the
    // harness's own ladder (the kimi-code line agrees).
    //
    // So the default is stated out loud instead: "omitted" means max on the
    // server, so an unstated level was silently the most expensive one, and a
    // caller asking for `low` was quietly clamped back to the fake tier.
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'max',
    maxAttachments: 4,
    maxImageBytes: 10 * 1024 * 1024,
    maxVideoBytes: 50 * 1024 * 1024,
    filesApiDocumented: true,
    // 2026-10-19, on this subscription endpoint and the GA id: thinking is on
    // with no `output_config` at all (so it is forced, not defaulted into the
    // request), `effort` moves the thinking token count (low 289, max 412 on
    // the same prompt), and an inline image block is accepted and answered.
    // The output cap and the 4-attachment figure are carried over from the
    // preview entry: the docs state a 1M context window, not an output cap or a
    // per-model attachment count, and neither is cheap to re-measure.
    description: 'Flash model with a 1M context window. Thinking is forced on with a selectable effort level. Accepts up to 4 attachments.',
  },
]

const BY_ID = new Map(MINIMAX_CODE_MODELS.map((model) => [model.id, model]))

/**
 * Ids this line used to serve, mapped to the id that replaced them.
 *
 * MiniMax published `MiniMax-M3.1-Flash` on 2026-10-19 and dropped the
 * `-Preview` suffix; the preview id was measured answering 200 the same day.
 * A stored selection, a saved conversation or a hand-edited route may still
 * name the old id, and dropping it on sight would empty a selection the user
 * made on purpose: the picker would show no model at all. The map is one-way,
 * because the old id and the new one are the same model and only the spelling
 * changed.
 */
const RENAMED_MODEL_IDS: Readonly<Record<string, string>> = {
  'MiniMax-M3.1-Flash-Preview': 'MiniMax-M3.1-Flash',
}

/**
 * The id a model name resolves to now.
 *
 * The WIRE still carries whatever id the caller asked for, so a session
 * recorded under the old id keeps talking to the id it was recorded with - and
 * keeps its replayed thinking blocks, whose signatures belong to that model.
 * Only the LOOKUP is renamed: a retired id now finds the same catalog entry
 * the new id finds, so its capabilities, its context window and its thinking
 * shape stay exactly what they were.
 */
export function resolveMinimaxCodeModelId(modelId: string): string {
  const trimmed = modelId.trim()
  return RENAMED_MODEL_IDS[trimmed] ?? trimmed
}

/** The retired ids that now name one model. */
function retiredIdsFor(modelId: string): string[] {
  return Object.keys(RENAMED_MODEL_IDS).filter((retired) => RENAMED_MODEL_IDS[retired] === modelId)
}

/** Registry entry for one model id, or undefined when the id is unknown. */
export function minimaxCodeModelDef(modelId: string): MinimaxCodeCatalogModel | undefined {
  return BY_ID.get(resolveMinimaxCodeModelId(modelId))
}

/**
 * Membership test for one known model id.
 *
 * A retired id counts: it still names a model this line serves, so a caller
 * asking whether an id is known gets the honest answer instead of a denial
 * that would only be true of the spelling.
 */
export function isMinimaxCodeModelId(value: unknown): boolean {
  return typeof value === 'string' && BY_ID.has(resolveMinimaxCodeModelId(value))
}

/** Display name for one model id, falling back to the raw id so nothing is hidden. */
export function minimaxCodeModelName(modelId: string): string {
  return BY_ID.get(resolveMinimaxCodeModelId(modelId))?.name ?? modelId
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
): MinimaxCodeReasoningEffort | null {
  const model = minimaxCodeModelDef(modelId)
  if (model === undefined) return null
  // A model with no selectable level has nothing to put on the wire; saying
  // otherwise would send a level the model does not accept.
  if (model.reasoningEfforts.length === 0) return null
  if (requested === undefined || requested === null) return model.defaultReasoningEffort
  const normalized = requested.trim().toLowerCase()
  const match = model.reasoningEfforts.find((effort) => effort === normalized)
  return match ?? model.defaultReasoningEffort
}

// ---------------------------------------------------------------------------
// Settings view of the catalog
// ---------------------------------------------------------------------------

/**
 * Smallest context window an override may name.
 *
 * Exported because the settings route validates POSTed overrides against the
 * same number this reader uses: if they drifted, the route would accept a value
 * the reader then treats as absent, and the card would show a saved override
 * that silently does nothing.
 */
export const MIN_CONTEXT_WINDOW = 1_000

/**
 * The effective context window for one model.
 *
 * One reader for both the status card and the request path, because the two
 * disagreeing is the exact failure this override can cause: the card would show
 * a window the request builder then ignored, and the user would see a request
 * clamped to the catalog's number with nothing on screen explaining why.
 *
 * A non-positive or sub-minimum override is treated as absent rather than
 * clamped: the route never stores one (it validates them), so seeing one means
 * the document was hand-edited, and inventing a window from it would size every
 * request on that model against a number the user never chose.
 */
export function contextWindowForModel(
  modelId: string,
  contextWindowOverrides: Record<string, number> | undefined,
): number {
  const trimmed = modelId.trim()
  const resolved = resolveMinimaxCodeModelId(trimmed)
  const fallback = BY_ID.get(resolved)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  // The override is looked up under the id the caller named, under the id that
  // name resolves to, and under the retired ids that resolve to it, so a window
  // the user set before the rename keeps applying to the same model instead of
  // silently reverting to the catalog's number.
  for (const candidate of [trimmed, resolved, ...retiredIdsFor(resolved)]) {
    const override = contextWindowOverrides?.[candidate]
    if (typeof override === 'number' && Number.isFinite(override) && override >= MIN_CONTEXT_WINDOW) {
      return Math.floor(override)
    }
  }
  return fallback
}

/**
 * The catalog ids the user's stored selection actually resolves to.
 *
 * A stored list that still equals the shipped default has never been edited, so
 * it cannot know about models a later release added; treating it as "everything
 * the catalog currently offers" is what keeps a first run from hiding a new
 * model behind an unedited default. Any explicit edit is honoured exactly, and
 * an id the catalog no longer serves is dropped so the picker cannot offer a
 * model this build has no entry for.
 */
export function resolveMinimaxCodeEnabledModelIds(
  stored: readonly string[],
  enabled = true,
): string[] {
  if (!enabled) return []
  const catalogIds = minimaxCodeModelIds()
  const shipped = new Set(catalogIds)
  // A stored id that has been renamed resolves to its successor FIRST, so a
  // selection made before the rename keeps the model it named instead of being
  // filtered away - which would leave the picker showing nothing at all.
  const resolved = stored.map((id) => resolveMinimaxCodeModelId(id))
  const isUntouchedDefault = resolved.length === shipped.size && resolved.every((id) => shipped.has(id))
  if (isUntouchedDefault) return catalogIds
  // De-duplicated: a stored list naming both the old and the new spelling of
  // one model resolves to one entry, and the picker must not list it twice.
  return [...new Set(resolved)].filter((id) => shipped.has(id))
}

/**
 * The settings-card rows for the whole shipped catalog.
 *
 * Every model is present, enabled or not: the card toggles rows, so a disabled
 * model has to be rendered to be re-enabled. `contextWindow` is the effective
 * window and `defaultContextWindow` the catalog's own number, which is what lets
 * the card show a modified row as modified.
 */
export function buildMinimaxCodeModelOptions(
  storedEnabledModelIds: readonly string[],
  contextWindowOverrides: Record<string, number>,
  enabled = true,
): MinimaxCodeModelOption[] {
  const enabledIds = new Set(resolveMinimaxCodeEnabledModelIds(storedEnabledModelIds, enabled))
  return MINIMAX_CODE_MODELS.map((model) => {
    const contextWindow = contextWindowForModel(model.id, contextWindowOverrides)
    return {
      id: model.id,
      name: model.name,
      enabled: enabledIds.has(model.id),
      defaultContextWindow: model.contextWindow,
      contextWindow,
      // Sized against the effective window, not the catalog's: an override that
      // shrank the window has to shrink the cap with it, or the request asks for
      // more output than the window it was measured against can hold.
      defaultMaxTokens: maxOutputTokensFor(model.id, contextWindow),
      reasoningEfforts: [...model.reasoningEfforts],
      // A model with no level publishes no level: the field is absent rather
      // than null, because the client renders it as "this model has no ladder".
      defaultReasoningEffort: model.defaultReasoningEffort ?? undefined,
      thinking: model.thinking as MinimaxCodeThinkingModeDto,
      description: model.description,
    }
  })
}
