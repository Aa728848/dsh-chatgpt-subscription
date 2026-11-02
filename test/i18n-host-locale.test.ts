/**
 * The Host's own language support: normalization, the runtime the client mirror
 * fills, and the provider names built on top of it.
 *
 * Two invariants are load-bearing and are asserted here rather than left to the
 * compiler: Chinese stays the default (an install that never mirrors must keep
 * the wording it shipped with), and the three dictionaries carry the same keys
 * with the same placeholders (a value that lost a `{name}` renders a sentence
 * with a hole in it, which no type can catch).
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, normalizeLocale } from '../src/shared/i18n-contracts.ts'
import { HostLocaleRuntime, currentLocale, installHostLocale } from '../src/host/common/i18n/runtime.ts'
import { interpolate, t, translate } from '../src/host/common/i18n/t.ts'
import { localizedProviderName } from '../src/host/common/i18n/provider-name.ts'
import { en } from '../src/host/common/i18n/en.ts'
import { ru } from '../src/host/common/i18n/ru.ts'
import { zh } from '../src/host/common/i18n/zh.ts'

describe('normalizeLocale', () => {
  it('keeps a supported bare language', () => {
    expect(normalizeLocale('zh')).toBe('zh')
    expect(normalizeLocale('en')).toBe('en')
    expect(normalizeLocale('ru')).toBe('ru')
  })

  it('reduces a regional tag to its language', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh')
    expect(normalizeLocale('zh_TW')).toBe('zh')
    expect(normalizeLocale('ru-RU')).toBe('ru')
    expect(normalizeLocale('EN-us')).toBe('en')
  })

  it('falls back to the default for an unsupported or absent value', () => {
    expect(normalizeLocale('fr')).toBe(DEFAULT_LOCALE)
    expect(normalizeLocale('')).toBe(DEFAULT_LOCALE)
    expect(normalizeLocale(undefined)).toBe(DEFAULT_LOCALE)
    expect(normalizeLocale(null)).toBe(DEFAULT_LOCALE)
    expect(normalizeLocale(7)).toBe(DEFAULT_LOCALE)
  })

  it('defaults to Chinese, which is what the plugin said before it spoke three languages', () => {
    expect(DEFAULT_LOCALE).toBe('zh')
    expect(SUPPORTED_LOCALES).toEqual(['zh', 'en', 'ru'])
  })
})

describe('HostLocaleRuntime', () => {
  it('starts on the default and adopts a normalized hint', () => {
    const runtime = new HostLocaleRuntime()
    expect(runtime.get()).toBe('zh')
    expect(runtime.set('ru-RU')).toBe('ru')
    expect(runtime.get()).toBe('ru')
  })

  it('notifies only a change, never a repeat of the same language', () => {
    const runtime = new HostLocaleRuntime()
    const listener = vi.fn()
    runtime.subscribe(listener)
    runtime.set('ru')
    runtime.set('ru-RU')
    runtime.set('zh')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stops notifying after unsubscribe', () => {
    const runtime = new HostLocaleRuntime()
    const listener = vi.fn()
    const off = runtime.subscribe(listener)
    off()
    runtime.set('en')
    expect(listener).not.toHaveBeenCalled()
  })

  it('answers the default through currentLocale when nothing is installed', () => {
    installHostLocale(undefined)
    expect(currentLocale()).toBe('zh')
  })

  it('answers the installed runtime and detaches again', () => {
    const runtime = new HostLocaleRuntime()
    installHostLocale(runtime)
    runtime.set('en')
    expect(currentLocale()).toBe('en')
    installHostLocale(undefined)
    expect(currentLocale()).toBe('zh')
  })
})

describe('dictionaries', () => {
  it('carry the same keys in all three languages', () => {
    const keys = Object.keys(zh).sort()
    expect(Object.keys(en).sort()).toEqual(keys)
    expect(Object.keys(ru).sort()).toEqual(keys)
  })

  it('keep the same placeholders per key', () => {
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((match) => match[1]).sort()
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]))
      expect(placeholders(ru[key]), key).toEqual(placeholders(zh[key]))
    }
  })
})

describe('translate', () => {
  it('answers each language in its own words', () => {
    expect(translate('zh', 'provider.claude')).toBe('Claude（订阅）')
    expect(translate('en', 'provider.claude')).toBe('Claude Subscription')
    expect(translate('ru', 'provider.claude')).toBe('Claude (подписка)')
  })

  it('fills placeholders and leaves an absent parameter visible', () => {
    expect(interpolate('{name} / {count}', { name: 'x', count: 2 })).toBe('x / 2')
    expect(interpolate('{name} / {count}', { name: 'x' })).toBe('x / {count}')
    expect(interpolate('no placeholders')).toBe('no placeholders')
  })

  it('reads the installed language through t', () => {
    const runtime = new HostLocaleRuntime()
    installHostLocale(runtime)
    expect(t('provider.claude')).toBe('Claude（订阅）')
    runtime.set('ru')
    expect(t('provider.claude')).toBe('Claude (подписка)')
    installHostLocale(undefined)
  })
})

describe('localizedProviderName', () => {
  it('follows the installed language for a known provider', () => {
    const runtime = new HostLocaleRuntime()
    installHostLocale(runtime)
    expect(localizedProviderName('glm-coding-plan', 'GLM (ZCode Account)')).toBe('GLM（ZCode 账号）')
    runtime.set('en')
    expect(localizedProviderName('glm-coding-plan', 'GLM (ZCode Account)')).toBe('GLM (ZCode Account)')
    runtime.set('ru')
    expect(localizedProviderName('glm-coding-plan', 'GLM (ZCode Account)')).toBe('GLM (аккаунт ZCode)')
    installHostLocale(undefined)
  })

  it('keeps the adapter constant for an unknown provider', () => {
    expect(localizedProviderName('some-other-provider', 'Some Other')).toBe('Some Other')
  })
})
