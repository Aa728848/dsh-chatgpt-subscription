// @vitest-environment jsdom
/**
 * Provider cards follow the active locale.
 *
 * Every card used to render its `zh` object directly, so the whole detail page
 * stayed Chinese on an English UI even though the dictionaries carry a complete
 * English half. This pins the fix at the DOM level: the same card renders
 * English under an English locale, Chinese under a Chinese one, and switches
 * without a remount when the user changes the language.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocaleRuntime, LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import type { ClaudeWebStatus } from '../src/shared/claude-contracts.ts'
import { ClaudeSection } from '../src/client/claude/ClaudeSection.tsx'
import { dictionaries, NS_CLAUDE, en, zh } from '../src/client/claude/locales.ts'
import { installLineLocale } from '../src/client/common/line-locale.ts'

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
    selectedAccountId: null,
    accounts: [],
    rotationStrategy: 'sequential',
    cacheTtl: null,
  }
}

/**
 * The slice of LocaleRuntime the cards use, with one namespace registered and
 * the active locale writable — enough to prove a card reads the registry and
 * re-renders on a switch, which is the whole contract under test.
 */
function fakeLocale(initial: 'en' | 'zh'): LocaleRuntime & { setLocale(id: 'en' | 'zh'): void } {
  let active: 'en' | 'zh' = initial
  let revision = 0
  const listeners = new Set<() => void>()
  const dicts: Record<string, Record<string, string>> = { en, zh }
  const snapshot = (): LocaleSnapshot => ({
    active,
    locales: [{ id: 'en', label: 'English' }, { id: 'zh', label: '中文', fallback: 'en' }],
    revision,
  })
  const runtime = {
    register: () => () => undefined,
    bind: (ns: string) => (key: string) => (ns === NS_CLAUDE ? (dicts[active][key] ?? key) : key),
    getSnapshot: snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setLocale: (id: 'en' | 'zh') => {
      active = id
      revision += 1
      for (const listener of [...listeners]) listener()
    },
  }
  return runtime as unknown as LocaleRuntime & { setLocale(id: 'en' | 'zh'): void }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let realFetch: typeof fetch | undefined

async function mount(): Promise<HTMLDivElement> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  realFetch ??= globalThis.fetch
  globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: status() })) as unknown as typeof fetch
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(ClaudeSection, {})))
  return container
}

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

describe('provider cards read the registered namespace, not their own dictionary', () => {
  it('renders English copy under an English locale', async () => {
    installLineLocale(fakeLocale('en'))
    const node = await mount()

    expect(node.textContent).toContain(en.quotaSection)
    // The shipped dictionary is still there and still Chinese; what changed is
    // that the card no longer renders it unconditionally.
    expect(zh.quotaSection).not.toBe(en.quotaSection)
    expect(node.textContent).not.toContain(zh.quotaSection)
  })

  it('renders Chinese copy under a Chinese locale', async () => {
    installLineLocale(fakeLocale('zh'))
    const node = await mount()

    expect(node.textContent).toContain(zh.quotaSection)
    expect(node.textContent).not.toContain(en.quotaSection)
  })

  it('switches language without remounting the card', async () => {
    const locale = fakeLocale('en')
    installLineLocale(locale)
    const node = await mount()
    expect(node.textContent).toContain(en.quotaSection)

    await act(async () => locale.setLocale('zh'))
    expect(node.textContent).toContain(zh.quotaSection)
    expect(node.textContent).not.toContain(en.quotaSection)
  })

  it('keeps every registered namespace bilingual, so a switch can never leave a gap', () => {
    // The bug was reachable only because the dictionaries themselves were fine:
    // key parity is what makes "render the active locale" a safe default.
    expect(Object.keys(dictionaries.en).sort()).toEqual(Object.keys(dictionaries.zh).sort())
  })
})
