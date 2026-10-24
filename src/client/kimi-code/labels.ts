/**
 * Labels and ladders the two Kimi Code cards must agree on.
 *
 * The model checklist and the capability table both name a model's wire, and
 * both used to carry their own copy of the same two-way switch, so a new value
 * could be labelled one place and not the other. The wire and the thinking
 * ladder are facts about the model, not about the card, so they live here once
 * and are rendered from the same dictionary key everywhere.
 */
import type {
  KimiCodeModelOption,
  KimiCodeReasoningEffort,
  KimiCodeWire,
} from '../../shared/kimi-code-contracts.ts'
import { KIMI_CODE_REASONING_EFFORTS } from '../../shared/kimi-code-contracts.ts'
import type { KimiCodeDict } from './locales.ts'

/**
 * Name of the request/response dialect a model is served over.
 *
 * @param wire - dialect the adapter reports for this model.
 * @param t - dictionary of the card rendering it.
 */
export function wireLabel(wire: KimiCodeWire, t: KimiCodeDict): string {
  return wire === 'anthropic' ? t.wireAnthropic : t.wireOpenai
}

/** Human label for one thinking level. */
export function effortLabel(effort: KimiCodeReasoningEffort, t: KimiCodeDict): string {
  switch (effort) {
    case 'low': return t.effortLow
    case 'high': return t.effortHigh
    case 'max': return t.effortMax
    case 'none': return t.effortNone
    default: return effort
  }
}

/**
 * Thinking levels one model publishes, in the order the card renders them.
 *
 * The ladder is read, never assumed: a model that declares no levels gets an
 * empty list, and the picker then offers none of them rather than the generic
 * four. `none` is dropped for a thinking-only model — the host already strips
 * it, and filtering again is what keeps an older host, or a live catalog that
 * says nothing about thinking, from putting "thinking off" back on a menu whose
 * request the service answers with HTTP 400.
 *
 * @param model - one entry from the model directory.
 */
export function effortLadder(model: KimiCodeModelOption): KimiCodeReasoningEffort[] {
  const declared = model.reasoningEfforts ?? []
  // Levels outside this set are never sent by the adapter, so offering one here
  // would promise a level the request builder refuses to put on the wire.
  const known = KIMI_CODE_REASONING_EFFORTS.filter((effort) => declared.includes(effort))
  return model.thinkingType === 'only' ? known.filter((effort) => effort !== 'none') : known
}

/**
 * Whether one model may be asked to stop reasoning.
 *
 * Read from the model's own declaration rather than assumed: `only` is the one
 * value that makes the question a hard no — the service answers a
 * disabled-thinking request with HTTP 400 and names the model — while `no`
 * describes a model that never reasons, so there is no switch to offer either.
 * `both`, and a registry that says nothing about the id, keep the switch,
 * because that is what this line offered before the flag existed and the
 * service, not the card, is the authority on refusing a level.
 *
 * @param model - one entry from the model directory.
 */
export function canDisableThinking(model: KimiCodeModelOption): boolean {
  return model.thinkingType !== 'only' && model.thinkingType !== 'no'
}

/**
 * Thinking levels a conversation can actually be set to.
 *
 * The setting is one level for the whole line, so the three thinking levels are
 * the union of what the CHECKED models declare: a level no checked model
 * declares would be stored and then rejected on the first turn. "Thinking off"
 * is not one of those declared levels on most rows — it is a switch, not a
 * ladder rung — so it is decided by {@link canDisableThinking} instead, and it
 * disappears exactly when every checked model refuses to be switched off.
 *
 * With nothing checked there is no model to narrow it down and the full ladder
 * is offered.
 *
 * @param models - every model in the directory, checked or not.
 */
export function effortOptions(models: readonly KimiCodeModelOption[]): KimiCodeReasoningEffort[] {
  const enabled = models.filter((model) => model.enabled)
  if (enabled.length === 0) return [...KIMI_CODE_REASONING_EFFORTS]
  const declared = new Set(enabled.flatMap((model) => effortLadder(model)))
  const switchable = enabled.some((model) => canDisableThinking(model))
  return KIMI_CODE_REASONING_EFFORTS.filter((effort) =>
    effort === 'none' ? switchable : declared.has(effort))
}

/** Models that reason at every level, and so have no "thinking off". */
export function thinkingOnlyModels(models: readonly KimiCodeModelOption[]): KimiCodeModelOption[] {
  return models.filter((model) => model.thinkingType === 'only')
}