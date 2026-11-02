/**
 * Language ids this plugin speaks, and the one parser that decides which one a
 * tag means.
 *
 * The Host has no locale service of its own: the browser decides the active
 * language and the Host only learns it because the client mirrors it back. So
 * both halves must agree on one normalization rule, and this module is it —
 * shared, dependency-free and identical on both sides of the wire.
 * @module dsh-chatgpt-subscription/i18n-contracts
 */

/** Every language this plugin can answer in, in the order a picker shows them. */
export const SUPPORTED_LOCALES = ['zh', 'en', 'ru'] as const

/** One language id this plugin speaks. */
export type LocaleId = (typeof SUPPORTED_LOCALES)[number]

/**
 * The language used when nothing better is known.
 *
 * Deliberately `zh`: it is what the plugin said before it spoke three
 * languages, so an install that never mirrors a locale keeps its exact present
 * wording instead of silently switching language on upgrade.
 */
export const DEFAULT_LOCALE: LocaleId = 'zh'

/**
 * Reduce a BCP 47 tag (or anything a caller offers) to one supported language.
 *
 * `zh-CN`, `zh_TW` and `ZH` are all `zh`; `ru-RU` is `ru`; an unsupported
 * language (`fr`, `ja`) and a missing value both fall back to
 * {@link DEFAULT_LOCALE} rather than throwing — a language hint is never worth
 * failing a request over.
 *
 * @param tag - Candidate tag from a URL, a header, a settings document or an event.
 * @returns The supported language to answer in.
 */
export function normalizeLocale(tag: unknown): LocaleId {
  if (typeof tag !== 'string') return DEFAULT_LOCALE
  const base = tag.trim().toLowerCase().split(/[-_]/)[0]
  const match = SUPPORTED_LOCALES.find((id) => id === base)
  return match ?? DEFAULT_LOCALE
}
