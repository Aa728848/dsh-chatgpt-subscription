/**
 * Lookup and interpolation for the Host's own copy.
 *
 * Kept separate from the runtime so a test can ask for any language directly
 * (`translate('ru', …)`) without installing anything.
 * @module dsh-chatgpt-subscription/host/i18n/t
 */
import { SUPPORTED_LOCALES, type LocaleId } from '../../../shared/i18n-contracts.ts'
import { en } from './en.ts'
import { ru } from './ru.ts'
import { zh, type HostLocaleKey } from './zh.ts'
import { currentLocale } from './runtime.ts'

const DICTIONARIES: Readonly<Record<LocaleId, Readonly<Record<HostLocaleKey, string>>>> = { zh, en, ru }

/**
 * Copy for one key in one language, with `{name}` placeholders filled.
 *
 * @param locale - Language to answer in.
 * @param key - Key from the Chinese source dictionary.
 * @param params - Values for the placeholders the template declares.
 * @returns The rendered copy; a key missing from a language falls back to Chinese.
 */
export function translate(locale: LocaleId, key: HostLocaleKey, params?: Record<string, unknown>): string {
  const table = DICTIONARIES[locale] ?? zh
  const template = table[key] ?? zh[key] ?? key
  return interpolate(template, params)
}

/**
 * Copy for one key in the language currently in force.
 *
 * @param key - Key from the Chinese source dictionary.
 * @param params - Values for the placeholders the template declares.
 * @returns The rendered copy.
 */
export function t(key: HostLocaleKey, params?: Record<string, unknown>): string {
  return translate(currentLocale(), key, params)
}

/**
 * Fill `{name}` placeholders; an absent parameter leaves its placeholder alone
 * so a mis-wired call is visible rather than silently blank.
 *
 * @param template - Copy carrying placeholders.
 * @param params - Values by placeholder name.
 * @returns The rendered copy.
 */
export function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (whole, name: string) => {
    const value = params[name]
    if (value === undefined || value === null) return whole
    return String(value)
  })
}

/** Every language a Host dictionary exists for; the pack is complete by type. */
export const HOST_LOCALES: readonly LocaleId[] = SUPPORTED_LOCALES
