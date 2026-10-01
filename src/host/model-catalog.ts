import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { CODEX_CHATGPT_PROVIDER_ID } from '../compat.ts'
import { CODEX_MODEL_CATALOG, codexModelMaxTokens, isCodexReasoningEffort, reasoningEffortsForModel, resolveCodexCatalogEntry } from '../shared/model-catalog.ts'
import type { CodexCatalogEntry } from './codex-catalog.ts'
import type { SubscriptionPreferenceStore } from './preferences.ts'

export const PROVIDER_ID = CODEX_CHATGPT_PROVIDER_ID
export const PROVIDER_NAME = 'Codex（ChatGPT 订阅）' as const

export function listCodexModels(
  preferences?: SubscriptionPreferenceStore,
  live?: readonly CodexCatalogEntry[],
): LlmModelInfo[] {
  const status = preferences?.status()
  if (status?.enabled === false) return []
  // A live listing is narrower than the shipped table by design: it names what
  // this account may call. When it is empty the shipped table stands in, so a
  // failed listing widens the picker instead of emptying it.
  const listed = live !== undefined && live.length > 0
    ? live.map(entry => ({ id: entry.id, name: entry.name, inputModalities: entry.inputModalities }))
    : undefined
  const visible = new Set(status?.visibleModelIds ?? (listed ?? shippedModels()).map(entry => entry.id))
  const selected = (listed ?? shippedModels()).filter(entry => visible.has(entry.id))
  // A listing must not be able to empty the picker. On several plans the
  // subscription listing carries only the account's code-review slug
  // (`codex-auto-review`) and no chat model at all, so honouring it literally
  // would delete every model the user's own selection asks for. A listing that
  // cannot satisfy the selection is not a narrower view of what this account
  // may call, and the shipped table answers instead.
  const source = listed === undefined || selected.length > 0
    ? selected
    : shippedModels().filter(entry => visible.has(entry.id))
  return source.map((entry) => ({
    provider: PROVIDER_ID,
    id: entry.id,
    name: entry.name,
    inputModalities: [...entry.inputModalities],
  }))
}

/** The shipped table as picker rows. */
function shippedModels(): { id: string; name: string; inputModalities: readonly ('text' | 'image')[] }[] {
  return CODEX_MODEL_CATALOG.map(entry => ({ id: entry.id, name: entry.name, inputModalities: entry.inputModalities }))
}

export function resolveCodexModel(
  model: string,
  preferences?: SubscriptionPreferenceStore,
  live?: readonly CodexCatalogEntry[],
): LlmResolvedModelInfo {
  const entry = resolveCodexCatalogEntry(model)
  const liveEntry = live?.find(candidate => candidate.id === model)
  const status = preferences?.status()
  // Any catalog model may carry an override; a model without one falls back to
  // the value the catalog states, and a live listing outranks the shipped table
  // because the backend is the authority on what this plan currently serves.
  const configuredContextWindow = status?.contextWindowOverrides[model]
  // The listing's levels are filtered through the shared vocabulary: an effort
  // this line cannot express is not an effort the picker should offer.
  const listedEfforts = liveEntry?.reasoningEfforts?.filter(isCodexReasoningEffort)
  const efforts = listedEfforts !== undefined && listedEfforts.length > 0
    ? listedEfforts
    : reasoningEffortsForModel(model)
  // A listing default only applies when the shipped table did not name one this
  // line can express; otherwise the shipped default is the known-good choice.
  const statedDefault = liveEntry?.defaultReasoningEffort ?? entry.defaultReasoningEffort
  const defaultEffort = isCodexReasoningEffort(statedDefault) && efforts.includes(statedDefault)
    ? statedDefault
    : efforts[0]
  return {
    provider: PROVIDER_ID,
    id: model,
    // A live entry carries the backend's own display name, which is authoritative
    // for a model this shipped table has never heard of.
    name: liveEntry?.name ?? (entry.id === model ? entry.name : model),
    inputModalities: [...(liveEntry?.inputModalities ?? entry.inputModalities)],
    context: { contextWindow: configuredContextWindow ?? liveEntry?.contextWindow ?? entry.contextWindow },
    defaultMaxTokens: codexModelMaxTokens(model),
    // No `systemPromptUpdate: 'in-history'`: the Responses wire carries the system
    // prompt in the top-level `instructions` slot, never inside `input`, so this
    // route cannot read a later system message as the effective prompt. Declaring
    // it would make DSH append every later prompt while the earlier ones stayed
    // effective, and the mapper would have to drop them again.
    reasoning: {
      efforts: efforts.map((effort) => ({
        id: ReasoningEffortId(effort),
        name: effort,
      })),
      ...(defaultEffort ? { defaultEffort: ReasoningEffortId(defaultEffort) } : {}),
    },
  }
}
