import { describe, expect, it } from 'vitest'
import { accountPoolEn, accountPoolZh, type AccountPoolLabels } from '../src/client/common/account-pool-labels.ts'
import { en as chatgptEn, zh as chatgptZh } from '../src/client/locales.ts'
import { en as antigravityEn, zh as antigravityZh } from '../src/client/antigravity/locales.ts'
import { en as claudeEn, zh as claudeZh } from '../src/client/claude/locales.ts'
import { en as commandCodeEn, zh as commandCodeZh } from '../src/client/command-code/locales.ts'
import { en as kimiEn, zh as kimiZh } from '../src/client/kimi-code/locales.ts'
import { en as minimaxEn, zh as minimaxZh } from '../src/client/minimax-code/locales.ts'
import { en as ollamaEn, zh as ollamaZh } from '../src/client/ollama/locales.ts'

/**
 * The shared card's quota labels, in the order its markup uses them.
 *
 * A tab may reword a shared label — that is what the spread-and-override in each
 * `locales.ts` is for. What it must NOT do is define a key of the same name for
 * its own page: the spread is silent, so the tab's own entry wins and the shared
 * card renders the tab's wording with placeholders the card never fills. That is
 * how `quotaUsed` (`'已用 {percent}%'` on the MiniMax tab) reached the shared
 * progress bar's aria-label as `… 25% 已用 {percent}%`.
 *
 * These keys are asserted equal, so a future collision fails here instead of
 * shipping a screen reader a template.
 */
const SHARED_QUOTA_KEYS = [
  'accountQuota',
  'quotaNone',
  'quotaSnapshot',
  'quotaResets',
  'quotaExhausted',
  'quotaWindow',
  'quotaUsed',
  'quotaFactsScope',
] as const satisfies readonly (keyof AccountPoolLabels)[]

/**
 * The cooldown labels the shared card counts down with.
 *
 * The same rule as the quota labels above, and for the same reason: the shared
 * card renders them, so a tab that defines one of them for its own page would
 * have the card speak with the tab's words - and with placeholders the card
 * never fills.
 */
const SHARED_COOLDOWN_KEYS = [
  'cooldownLeft',
  'cooldownRemaining',
  'cooldownRemainingSeconds',
] as const satisfies readonly (keyof AccountPoolLabels)[]

/** Every shared label the card renders, in the order the two lists name them. */
const SHARED_KEYS = [...SHARED_QUOTA_KEYS, ...SHARED_COOLDOWN_KEYS]

/**
 * Tabs whose locale dictionary carries the shared set (spread in `locales.ts`).
 *
 * A tab that does not spread the shared set there is deliberately absent from
 * this table: it keeps its labels module-private inside its own card instead
 * (where the card's state and actions already live) and overrides the few keys
 * it means to override. A locale entry there cannot shadow a shared label, and
 * the overrides sit in one small function where they are visible.
 */
const TABS: Record<string, { zh: Record<string, string>; en: Record<string, string> }> = {
  chatgpt: { zh: chatgptZh, en: chatgptEn },
  antigravity: { zh: antigravityZh, en: antigravityEn },
  claude: { zh: claudeZh, en: claudeEn },
  'command-code': { zh: commandCodeZh, en: commandCodeEn },
  'kimi-code': { zh: kimiZh, en: kimiEn },
  'minimax-code': { zh: minimaxZh, en: minimaxEn },
  ollama: { zh: ollamaZh, en: ollamaEn },
}

describe('shared account-pool labels', () => {
  it('are present in every tab, in both locales', () => {
    for (const [tab, dicts] of Object.entries(TABS)) {
      for (const [locale, dict] of Object.entries(dicts)) {
        for (const key of SHARED_KEYS) {
          expect(dict[key], `${tab}/${locale} is missing the shared label "${key}"`).toBeTruthy()
        }
      }
    }
  })

  it('are never shadowed by a tab-local key of the same name', () => {
    for (const [tab, dicts] of Object.entries(TABS)) {
      for (const [locale, dict] of Object.entries(dicts)) {
        const shared = locale === 'zh' ? accountPoolZh : accountPoolEn
        for (const key of SHARED_KEYS) {
          expect(
            dict[key],
            `${tab}/${locale} redefines the shared label "${key}"; the shared card would render its wording`,
          ).toBe(shared[key])
        }
      }
    }
  })
})
