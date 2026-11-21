/**
 * Static facts and catalog shaping for the Antigravity (ACP) line.
 *
 * Everything here answers one question: what may this line claim about a model
 * without guessing? ACP publishes model ids and thinking levels at *runtime*,
 * per session, from the account that is signed in. So the only durable facts in
 * this file are the provider identity, the level vocabulary, and the rules for
 * collapsing the server's tier-suffixed ids back into one selectable model.
 *
 * The previous Antigravity line hard-coded a model table because Cloud Code
 * Assist published none to a third-party client. ACP does publish one, and a
 * hard-coded table beside it would be a second source of truth for the same
 * upstream fact - exactly the failure mode this line exists to avoid.
 *
 * @module dsh-chatgpt-subscription/host/antigravity-acp/types
 */

import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { AntigravityAcpModelDto } from '../../shared/antigravity-acp-contracts.ts'

/** Provider route this line registers. */
export const PROVIDER_ID = 'antigravity-acp'

/** Neutral English display name; the localized name comes from the host i18n table. */
export const PROVIDER_NAME = 'Antigravity (ACP)'

/** File name of the persisted catalog snapshot, under `<DSH_HOME>/storages/`. */
export const CATALOG_SNAPSHOT_NAME = 'antigravity-acp'

/** Directory the automatic download lands in, under `<DSH_HOME>/cache/`. */
export const BINARY_CACHE_DIR = 'antigravity-acp'

/** Environment override for the executable, checked before automatic download. */
export const BINARY_ENV_VAR = 'DSH_ANTIGRAVITY_ACP_BIN'

/**
 * Thinking-level vocabulary, least to greatest.
 *
 * ACP does not name a level set in the protocol: the server publishes one in the
 * `thought_level` config option and encodes a model's own ladder in its
 * `availableModels` suffixes. This order only decides presentation order and
 * the "is this level string one we understand" test; it never invents a level a
 * model does not publish.
 */
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** One thinking level this line understands. */
export type AntigravityAcpEffort = (typeof EFFORT_ORDER)[number]

/** Whether one string is a thinking level this line understands. */
export function isEffort(value: string): value is AntigravityAcpEffort {
  return (EFFORT_ORDER as readonly string[]).includes(value)
}

/**
 * Which sign-in method to hand the agent when it asks for one.
 *
 * The server publishes whatever method list the installed CLI supports, and the
 * order below is the line's preference: the personal OAuth flow first, then the
 * terminal flow, then a business account, then the API-key forms. This lives
 * here - not beside one call site - because two call sites ask the same question:
 * a main-model session (`adapter.openSession`) and the catalogue read
 * (`catalog.readCatalogFrom`). They used to disagree, one of them hard-coding
 * `oauth-personal` and getting a method the server never offered.
 *
 * @param authMethods - The ids the server announced in `initialize`.
 * @returns The method id to request.
 */
export function preferAuthMethod(authMethods: readonly string[]): string {
  for (const candidate of ['oauth-personal', 'terminal-login', 'oauth-business', 'gemini-api-key', 'agent-platform']) {
    if (authMethods.includes(candidate)) return candidate
  }
  return authMethods[0] ?? 'oauth-personal'
}

/** One model as the ACP server announced it, before collapsing. */
export interface AcpAvailableModel {
  modelId: string
  name?: string
  /** Context window the server published for this model, when it published one. */
  contextWindow?: number
}

/** The `model` config option as the ACP server announced it. */
export interface AcpModelOption {
  value: string
  name?: string
}

/**
 * Collapse the server's tier-suffixed model ids into one selectable model each.
 *
 * The server publishes two different lists that describe the same catalog:
 *
 * - `configOptions[model].options` - the values `session/set_config_option`
 *   accepts. These are the base ids (`gemini-4-carbon`).
 * - `availableModels` - the tier ids the model picker itself shows
 *   (`gemini-4-carbon-low`).
 *
 * A model's own ladder is the set of tier suffixes published for it. A model
 * with no suffixes (its id already carries the tier, such as
 * `gpt-oss-120b-medium`) publishes no ladder, and this function says so with an
 * empty list rather than borrowing a global one: `reasoning` is then simply not
 * offered for it.
 *
 * The `thought_level` option is deliberately NOT consulted here. That option
 * describes the levels of whichever model the session currently has selected -
 * Argon publishes low/medium/high - so intersecting every model's ladder with
 * it silently dropped the fourth level a newer model publishes for itself
 * (`gemini-4-hydrogen-xhigh` never reached the picker).
 *
 * @param options - The `model` option values, in server order.
 * @param availableModels - The tier ids, in server order.
 * @returns One entry per selectable model, with its ladder least to greatest.
 */
export function collapseModels(
  options: readonly AcpModelOption[],
  availableModels: readonly AcpAvailableModel[],
): AntigravityAcpModelDto[] {
  const byBase = new Map<string, Set<string>>()
  for (const option of options) {
    for (const candidate of availableModels) {
      const id = candidate.modelId
      if (!id.startsWith(option.value + '-')) continue
      const suffix = id.slice(option.value.length + 1)
      if (!isEffort(suffix)) continue
      const levels = byBase.get(option.value) ?? new Set<string>()
      levels.add(suffix)
      byBase.set(option.value, levels)
    }
  }
  return options.map((option) => {
    const levels = byBase.get(option.value)
    const efforts = levels === undefined
      ? []
      : EFFORT_ORDER.filter((level) => levels.has(level))
    // A window the server attached to any tier id of this model describes the
    // model itself, so it is carried up to the collapsed entry.
    const contextWindow = availableModels.find(
      (candidate) => candidate.contextWindow !== undefined
        && (candidate.modelId === option.value || candidate.modelId.startsWith(option.value + '-')),
    )?.contextWindow
    return {
      id: option.value,
      name: option.name ?? option.value,
      efforts,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    }
  })
}

/**
 * Context window this line declares for a model id the catalogue did not price.
 *
 * The values are the upstream Antigravity catalogue's own numbers, transcribed
 * from the retired `antigravity` line's catalogue (the same upstream, one
 * transport earlier): the Gemini 4 family and the Gemini 3.x flash models take
 * 1,048,576, `gpt-oss-120b` takes 131,072, the Claude models take 250,000, and
 * the Gemini 3.1 flash image model takes 65,536.
 *
 * This is NOT a second model list: it never decides which models exist, only
 * how large a context the harness is told to expect. A window the server
 * publishes always wins (see {@link toResolvedModelInfo}).
 */
const SHIPPED_CONTEXT_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  ['gemini-3.1-flash-image', 65_536],
  ['gemini-4-', 1_048_576],
  ['gemini-3', 1_048_576],
  ['gpt-oss-', 131_072],
  ['claude-', 250_000],
]

/**
 * Window declared for an id the shipped table does not know.
 *
 * Deliberately the small end: a window that is too small compacts earlier than
 * the model needed, while one that is too large lets the harness send a request
 * past the real limit. 131,072 still leaves the default 65,536-token compaction
 * headroom a usable budget.
 */
export const FALLBACK_CONTEXT_WINDOW = 131_072

/**
 * Context window this line declares for one model id.
 *
 * @param modelId - Model id as the server published it.
 * @returns The shipped window for that family, else {@link FALLBACK_CONTEXT_WINDOW}.
 */
export function defaultContextWindow(modelId: string): number {
  for (const [prefix, contextWindow] of SHIPPED_CONTEXT_WINDOWS) {
    if (modelId.startsWith(prefix)) return contextWindow
  }
  return FALLBACK_CONTEXT_WINDOW
}

/**
 * Project one collapsed model into harness model metadata.
 *
 * @param provider - Registered provider route.
 * @param model - One collapsed model.
 * @returns Harness-facing model info.
 */
export function toModelInfo(provider: string, model: AntigravityAcpModelDto): LlmModelInfo {
  return { provider, id: model.id, name: model.name, inputModalities: ['text', 'image'] }
}

/**
 * Project one collapsed model into exact-route metadata, including its ladder.
 *
 * A window is ALWAYS declared, because DSH treats an absent one as a broken
 * route rather than as "unknown": `dsh-compaction-basic` throws
 * `TargetPressureConfigError` on every model switch into the line, which the
 * harness surfaces as `MODEL_SWITCH_COMPACTION_FAILED` before the first token.
 * The order is: the window a live `usage_update` reported for this model, then
 * one the catalogue row carries, then the shipped family table.
 *
 * @param provider - Registered provider route.
 * @param model - One collapsed model.
 * @param observedContextWindow - Window the server reported for this model in a live turn, when it did.
 * @returns Harness-facing resolved model info, with `reasoning` only when a ladder was published.
 */
export function toResolvedModelInfo(
  provider: string,
  model: AntigravityAcpModelDto,
  observedContextWindow?: number,
): LlmResolvedModelInfo {
  const base = toModelInfo(provider, model)
  const contextWindow = observedContextWindow ?? model.contextWindow ?? defaultContextWindow(model.id)
  return {
    ...base,
    context: { contextWindow },
    ...(model.efforts.length === 0
      ? {}
      : {
          reasoning: {
            efforts: model.efforts.map((id) => ({ id: id as never, name: id })),
            defaultEffort: model.efforts[0] as never,
          },
        }),
  }
}

/**
 * Pick the model entry a caller's model id names.
 *
 * An id the catalog does not list is still resolvable - the harness accepts
 * unlisted ids on purpose - so this returns a minimal entry for it instead of
 * failing the call. What it does NOT do is guess a ladder for that id.
 *
 * @param models - Collapsed catalog.
 * @param modelId - Id the caller asked for.
 * @returns The catalog entry, or a bare one for an unlisted id.
 */
export function findModel(models: readonly AntigravityAcpModelDto[], modelId: string): AntigravityAcpModelDto {
  return models.find((model) => model.id === modelId) ?? { id: modelId, name: modelId, efforts: [] }
}

/** JSON-RPC error code the official server answers with when no credentials are cached. */
export const ACP_AUTH_REQUIRED_CODE = -32000

/** Sentence shown when the official server has no cached credentials. */
export const AUTH_REQUIRED_MESSAGE =
  'Antigravity is not signed in. Run `agy acp --login` in a terminal, or start the sign-in from this card.'

/** Sentence shown when no usable `agy` executable could be found or downloaded. */
export function missingBinaryMessage(detail: string): string {
  return `No usable Antigravity CLI (agy) was found and the official ACP server could not be downloaded: ${detail}`
}
