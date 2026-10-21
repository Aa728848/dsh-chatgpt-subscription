// @vitest-environment jsdom
/**
 * The Russian language pack.
 *
 * Two things must hold for it to be safe to ship: every dictionary covers the
 * exact key set of its Chinese/English sibling (otherwise a Russian user meets
 * a raw key name or an untranslated sentence), and installing it registers the
 * language and one dictionary per namespace, in the order the locale service
 * expects (definition first, dictionaries second — though the runtime accepts
 * either order, the definition is what makes the language selectable).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import type { ClaudeWebStatus } from '../src/shared/claude-contracts.ts'
import { dictionaries as antigravityDicts, NS_ANTIGRAVITY } from '../src/client/antigravity/locales.ts'
import { dictionaries as claudeDicts, NS_CLAUDE } from '../src/client/claude/locales.ts'
import { dictionaries as clinePassDicts, NS_CLINE_PASS } from '../src/client/cline-pass/locales.ts'
import { dictionaries as commandCodeDicts, NS_COMMAND_CODE } from '../src/client/command-code/locales.ts'
import { dictionaries as glmDicts, NS_GLM_CODING_PLAN } from '../src/client/glm-coding-plan/locales.ts'
import { dictionaries as kimiDicts, NS_KIMI_CODE } from '../src/client/kimi-code/locales.ts'
import { dictionaries as minimaxDicts, NS_MINIMAX_CODE } from '../src/client/minimax-code/locales.ts'
import { dictionaries as ollamaDicts, NS_OLLAMA } from '../src/client/ollama/locales.ts'
import { dictionaries as openDesignDicts, NS_OPENDESIGN } from '../src/client/opendesign/locales.ts'
import { dictionaries as progressUpdatesDicts, NS_PROGRESS_UPDATES } from '../src/client/progress-updates/locales.ts'
import { dictionaries as qoderDicts, NS_QODER } from '../src/client/qoder/locales.ts'
import { dictionaries as stepCodeDicts, NS_STEP_CODE } from '../src/client/step-code/locales.ts'
import { dictionaries as hubDicts, NS } from '../src/client/locales.ts'
import { ClaudeSection } from '../src/client/claude/ClaudeSection.tsx'
import { installLineLocale } from '../src/client/common/line-locale.ts'
import { RU_LOCALE, installRussianLocale } from '../src/client/locales-ru/index.ts'
import { dictionary as antigravityRu } from '../src/client/locales-ru/antigravity.ts'
import { dictionary as claudeRu } from '../src/client/locales-ru/claude.ts'
import { dictionary as clinePassRu } from '../src/client/locales-ru/cline-pass.ts'
import { dictionary as commandCodeRu } from '../src/client/locales-ru/command-code.ts'
import { dictionary as glmRu } from '../src/client/locales-ru/glm-coding-plan.ts'
import { dictionary as hubRu } from '../src/client/locales-ru/hub.ts'
import { dictionary as kimiRu } from '../src/client/locales-ru/kimi-code.ts'
import { dictionary as minimaxRu } from '../src/client/locales-ru/minimax-code.ts'
import { dictionary as ollamaRu } from '../src/client/locales-ru/ollama.ts'
import { dictionary as openDesignRu } from '../src/client/locales-ru/opendesign.ts'
import { dictionary as progressUpdatesRu } from '../src/client/locales-ru/progress-updates.ts'
import { dictionary as qoderRu } from '../src/client/locales-ru/qoder.ts'
import { dictionary as stepCodeRu } from '../src/client/locales-ru/step-code.ts'

/** Every namespace this pack covers, with all three dictionaries beside each other. */
const NAMESPACES = [
  { ns: NS, zh: hubDicts.zh as Record<string, string>, en: hubDicts.en as Record<string, string>, ru: hubRu },
  { ns: NS_CLAUDE, zh: claudeDicts.zh as Record<string, string>, en: claudeDicts.en as Record<string, string>, ru: claudeRu },
  { ns: NS_ANTIGRAVITY, zh: antigravityDicts.zh as Record<string, string>, en: antigravityDicts.en as Record<string, string>, ru: antigravityRu },
  { ns: NS_COMMAND_CODE, zh: commandCodeDicts.zh as Record<string, string>, en: commandCodeDicts.en as Record<string, string>, ru: commandCodeRu },
  { ns: NS_KIMI_CODE, zh: kimiDicts.zh as Record<string, string>, en: kimiDicts.en as Record<string, string>, ru: kimiRu },
  { ns: NS_MINIMAX_CODE, zh: minimaxDicts.zh as Record<string, string>, en: minimaxDicts.en as Record<string, string>, ru: minimaxRu },
  { ns: NS_GLM_CODING_PLAN, zh: glmDicts.zh as Record<string, string>, en: glmDicts.en as Record<string, string>, ru: glmRu },
  { ns: NS_OLLAMA, zh: ollamaDicts.zh as Record<string, string>, en: ollamaDicts.en as Record<string, string>, ru: ollamaRu },
  { ns: NS_STEP_CODE, zh: stepCodeDicts.zh as Record<string, string>, en: stepCodeDicts.en as Record<string, string>, ru: stepCodeRu },
  { ns: NS_CLINE_PASS, zh: clinePassDicts.zh as Record<string, string>, en: clinePassDicts.en as Record<string, string>, ru: clinePassRu },
  { ns: NS_QODER, zh: qoderDicts.zh as Record<string, string>, en: qoderDicts.en as Record<string, string>, ru: qoderRu },
  { ns: NS_OPENDESIGN, zh: openDesignDicts.zh as Record<string, string>, en: openDesignDicts.en as Record<string, string>, ru: openDesignRu },
  { ns: NS_PROGRESS_UPDATES, zh: progressUpdatesDicts.zh as Record<string, string>, en: progressUpdatesDicts.en as Record<string, string>, ru: progressUpdatesRu },
]

/** `{name}` placeholders in a template, in the order they appear. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{[a-zA-Z0-9_]+\}/g)].map((match) => match[0]).sort()
}

const CJK = /[\u4e00-\u9fff]/

describe('Russian language pack', () => {
  it.each(NAMESPACES)('$ns covers the same keys as its shipped dictionaries', ({ zh, en, ru }) => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(zh).sort())
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort())
  })

  it.each(NAMESPACES)('$ns keeps every {placeholder} intact', ({ en, ru }) => {
    // A dropped placeholder does not fail any type: the sentence renders with
    // the raw "{count}" gone and reads as a bald claim.
    for (const [key, template] of Object.entries(ru)) {
      expect(placeholders(template), `${key}`).toEqual(placeholders(en[key] ?? ''))
    }
  })

  it.each(NAMESPACES)('$ns is actually Russian, not a copy of the fallback', ({ zh, en, ru }) => {
    for (const [key, template] of Object.entries(ru)) {
      expect(CJK.test(template), `${key} still contains Chinese`).toBe(false)
      // A few keys are deliberately empty in the shipped dictionaries (a unit
      // suffix the template already carries); those may stay empty here too.
      if ((en[key] ?? '') === '') continue
      expect(template.trim(), `${key} is empty`).not.toBe('')
    }
    // Brand-only keys legitimately equal their English value; a whole namespace
    // copying English would mean nobody translated it.
    const untouched = Object.entries(ru).filter(([key, template]) => template === en[key]).length
    expect(untouched).toBeLessThan(Object.keys(zh).length)
  })

  it('registers the language once and one dictionary per namespace', () => {
    const languages: Array<Record<string, unknown>> = []
    const dictionaries: Array<[string, string, Record<string, string>]> = []
    const disposers: Array<() => void> = []
    const ctx = {
      effect(factory: () => () => void) {
        const dispose = factory()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      locale: {
        addLanguage(input: Record<string, unknown>) {
          languages.push(input)
          return () => undefined
        },
        register(ns: string, locale: string, dict: Record<string, string>) {
          dictionaries.push([ns, locale, dict])
          return () => undefined
        },
      },
    }

    installRussianLocale(ctx as never)

    expect(languages).toEqual([{ id: RU_LOCALE, label: 'Русский', fallback: 'en' }])
    expect(dictionaries.map(([ns]) => ns).sort()).toEqual(NAMESPACES.map(({ ns }) => ns).sort())
    expect(dictionaries.every(([, locale]) => locale === RU_LOCALE)).toBe(true)
    // One language registration + one per namespace, each owning its disposer.
    expect(disposers).toHaveLength(NAMESPACES.length + 1)
  })
})

const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT

function status(): ClaudeWebStatus {
  return {
    enabled: true,
    authenticated: true,
    hasCredentials: true,
    storagePath: '/tmp/claude-credentials.json',
    serving: true,
    conflict: null,
    claudeCodeSignInAvailable: false,
    claudeCodePaths: [],
    account: { email: 'user@example.com', subscriptionType: 'max' },
    quota: null,
    lastFetchedAt: Date.now(),
    quotaError: null,
    models: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    cacheTtl: null,
    selectedAccountId: null,
    accounts: [],
    rotationStrategy: 'sequential',
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let realFetch: typeof fetch | undefined

beforeEach(() => {
  vi.stubGlobal('open', vi.fn())
})

afterEach(async () => {
  if (root !== null) await act(async () => root!.unmount())
  root = null
  container?.remove()
  container = null
  globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  if (realFetch !== undefined) globalThis.fetch = realFetch
  realFetch = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a card rendered in Russian', () => {
  it('shows the Russian dictionary, and falls back to English for a key the pack lacks', async () => {
    const revision = 0
    const snapshot: LocaleSnapshot = {
      active: RU_LOCALE,
      locales: [{ id: 'en', label: 'English' }, { id: RU_LOCALE, label: 'Русский', fallback: 'en' }],
      revision,
    }
    // The runtime's own lookup walks ru → en; the stub does the same over the
    // two dictionaries, which is the behaviour the card depends on.
    installLineLocale({
      register: () => () => undefined,
      bind: (ns: string) => (key: string) => {
        if (ns !== NS_CLAUDE) return key
        return claudeRu[key as keyof typeof claudeRu] ?? claudeDicts.en[key as keyof typeof claudeDicts.en] ?? key
      },
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
    } as never)

    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    realFetch ??= globalThis.fetch
    globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: status() })) as unknown as typeof fetch
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(createElement(ClaudeSection, {})))

    expect(container.textContent).toContain(claudeRu.quotaSection)
    expect(container.textContent).not.toContain(claudeDicts.zh.quotaSection)
    expect(container.textContent).not.toContain(claudeDicts.en.quotaSection)
  })
})
