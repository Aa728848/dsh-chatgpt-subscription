/**
 * Provider display names, resolved in the language in force.
 *
 * The harness carries one name per provider (`LlmProviderInfo`) with no locale
 * field and no request context, so a name that followed the *browser* language
 * on its own is impossible. What makes it follow is the client mirror: the
 * browser publishes its resolved locale, the Host remembers it, and this lookup
 * reads that value each time the harness asks. A Host that was never mirrored
 * answers with the adapter's own constant, which is the neutral English name.
 * @module dsh-chatgpt-subscription/host/i18n/provider-name
 */
import type { HostLocaleKey } from './zh.ts'
import { t } from './t.ts'

/** Provider id to the key that names it. */
const NAME_KEYS: ReadonlyMap<string, HostLocaleKey> = new Map<string, HostLocaleKey>([
  ['codex-chatgpt', 'provider.codex-chatgpt'],
  ['claude-subscription', 'provider.claude'],
  ['workbuddy-subscription', 'provider.workbuddy'],
  ['glm-coding-plan', 'provider.glm-coding-plan'],
  ['minimax-code', 'provider.minimax-code'],
  ['qoder', 'provider.qoder'],
  ['step-code', 'provider.step-code'],
])

/**
 * The name one provider registers under, in the language in force.
 *
 * @param providerId - Id the harness asked about.
 * @param fallback - The adapter's own neutral name, used when this build has no
 * translation for the id (a provider this table does not know).
 * @returns Localized display name, or `fallback`.
 */
export function localizedProviderName(providerId: string, fallback: string): string {
  const key = NAME_KEYS.get(providerId)
  return key === undefined ? fallback : t(key)
}
