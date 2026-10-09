// @vitest-environment jsdom
/**
 * The Antigravity tab renders the shared account card.
 *
 * This tab was the source of the card, so its own JSX is now thin wiring: these
 * assertions pin that wiring — the accounts from the status payload reach the
 * shared card, the strategy select offers all three strategies, and an action
 * posts to the provider's own accounts route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AntigravitySection } from '../src/client/antigravity/AntigravitySection.tsx'
import { zh } from '../src/client/antigravity/locales.ts'

/** Optional fields stay optional so a fixture can drop a cooldown without a cast. */
interface AccountFixture {
  id: string
  alias: string
  email: string
  projectId: string
  isPrimary: boolean
  lastUsedAt?: number
  cooldownUntil?: number
}

const PRIMARY: AccountFixture = {
  id: 'acc_1',
  // Deliberately not the badge label, so a badge assertion cannot pass on the title.
  alias: '主力账号',
  email: 'primary@example.com',
  projectId: 'proj-primary',
  isPrimary: true,
  lastUsedAt: Date.now() - 60_000,
}

const SECOND: AccountFixture = {
  id: 'acc_2',
  alias: '备用账号',
  email: 'second@example.com',
  projectId: 'proj-second',
  isPrimary: false,
  cooldownUntil: Date.now() + 10 * 60_000,
}

function statusPayload(accounts = [PRIMARY, SECOND], rotationStrategy = 'sticky') {
  return {
    authenticated: true,
    enabled: true,
    accounts,
    activeAccountId: 'acc_1',
    rotationStrategy,
    storagePath: 'C:\\Users\\A\\.dsh\\storages\\antigravity-pool.json.dpapi',
    contextWindowOverrides: {},
    models: [],
    quota: { groups: [] },
  }
}

let originalFetch: typeof globalThis.fetch
let originalActEnvironment: boolean | undefined
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  globalThis.fetch = originalFetch
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  vi.restoreAllMocks()
})

describe('Antigravity account card', () => {
  it('renders the pooled accounts through the shared card', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe('/antigravity/api/status')
      return Response.json({ ok: true, value: statusPayload() })
    })
    globalThis.fetch = fetchMock as typeof fetch

    await act(async () => root.render(createElement(AntigravitySection, {})))

    expect(container.querySelectorAll('.dsha-account-card')).toHaveLength(2)
    expect(container.querySelector('.dsha-account-title')?.textContent).toBe('主力账号')
    const firstCard = container.querySelectorAll('.dsha-account-card')[0]!
    expect(firstCard.querySelector('.dsha-badge.primary')?.textContent).toBe(zh.primaryAccount)
    expect(firstCard.querySelector('.dsha-badge.active')?.textContent).toBe(zh.activeAccount)
    // The cooling account shows the shared badge.
    expect(container.textContent).toContain(zh.cooling)
    // Provider-specific rows come from renderDetails.
    expect(container.textContent).toContain('proj-second')
    expect(container.textContent).toContain('second@example.com')

    const select = container.querySelector<HTMLSelectElement>('.dsha-select')
    expect(select).not.toBeNull()
    expect([...select!.options].map((option) => option.value)).toEqual(['sequential', 'round-robin', 'sticky'])
    expect(select!.value).toBe('sticky')
    // The model list is a named group, not one a screen reader announces as bare
    // "group" — the shared checklist takes its name from this line's dictionary.
    expect(container.querySelector('.dsh-mcl-list')?.getAttribute('aria-label')).toBe(zh.modelsSection)
  })

  it('promotes another account through the provider accounts route', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
      calls.push({ url: String(url), body })
      if (String(url) === '/antigravity/api/accounts') {
        return Response.json({ ok: true, value: statusPayload([
          { ...PRIMARY, isPrimary: false },
          { ...SECOND, isPrimary: true, cooldownUntil: undefined },
        ], 'sticky') })
      }
      return Response.json({ ok: true, value: statusPayload() })
    })
    globalThis.fetch = fetchMock as typeof fetch

    await act(async () => root.render(createElement(AntigravitySection, {})))
    const promote = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === zh.setPrimary)
    expect(promote).toBeDefined()
    await act(async () => promote!.click())

    expect(calls[1]).toEqual({ url: '/antigravity/api/accounts', body: { action: 'set-primary', accountId: 'acc_2' } })
    // The refreshed status is adopted: the second account is now primary.
    const cards = [...container.querySelectorAll('.dsha-account-card')]
    expect(cards[0]?.querySelector('.dsha-badge.primary')).toBeNull()
    expect(cards[1]?.querySelector('.dsha-badge.primary')?.textContent).toBe(zh.primaryAccount)
  })

  it('clears a cooldown through the shared badge action', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      if (String(url) === '/antigravity/api/accounts') {
        return Response.json({ ok: true, value: statusPayload([PRIMARY, { ...SECOND, cooldownUntil: undefined }]) })
      }
      return Response.json({ ok: true, value: statusPayload() })
    })
    globalThis.fetch = fetchMock as typeof fetch

    await act(async () => root.render(createElement(AntigravitySection, {})))
    const clear = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === zh.clearCooldown)
    expect(clear).toBeDefined()
    await act(async () => clear!.click())

    expect(calls[1]).toEqual({ url: '/antigravity/api/accounts', body: { action: 'clear-cooldown', accountId: 'acc_2' } })
    expect(container.textContent).not.toContain(zh.cooling)
  })

  it('falls back to sticky when the host reports no strategy', async () => {
    const { rotationStrategy: _omitted, ...withoutStrategy } = statusPayload()
    globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: withoutStrategy })) as typeof fetch

    await act(async () => root.render(createElement(AntigravitySection, {})))

    // The fallback matches the host's own default, so the card never shows a
    // strategy the adapter is not using.
    expect(container.querySelector<HTMLSelectElement>('.dsha-select')!.value).toBe('sticky')
  })

  it('renders the session cache totals the status reports', async () => {
    const withCache = {
      ...statusPayload(),
      cache: {
        requests: 4,
        cachedTokens: 3800,
        freshTokens: 200,
        hitRatio: 0.95,
        // A total miss, reported with the idle gap that preceded it: the cache
        // expires on idle time, and this is the pair the card exists to show.
        lastMiss: { cause: 'none' as const, idleMs: 183_000, at: 1_791_552_655_806 },
      },
    }
    globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: withCache })) as typeof fetch

    await act(async () => root.render(createElement(AntigravitySection, {})))

    expect(container.textContent).toContain(zh.cacheSection)
    expect(container.textContent).toContain('95.0%')
    expect(container.textContent).toContain(zh.cacheCached + ': 3,800')
    expect(container.textContent).toContain(zh.cacheFresh + ': 200')
    expect(container.textContent).toContain(zh.cacheRequests + ': 4')
    // The miss is named, and the idle reading is rendered in human units rather
    // than raw milliseconds. The label and value are separate spans, so each is
    // asserted on its own rather than as one joined string.
    expect(container.textContent).toContain(zh.cacheMiss)
    expect(container.textContent).toContain(zh.cacheDriftNone)
    expect(container.textContent).toContain(zh.cacheMissIdle)
    expect(container.textContent).toContain('3m 3s')
  })

  it('reports no miss while every turn has hit the cache', async () => {
    const warm = {
      ...statusPayload(),
      cache: { requests: 3, cachedTokens: 9000, freshTokens: 300, hitRatio: 0.968 },
    }
    globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: warm })) as typeof fetch

    await act(async () => root.render(createElement(AntigravitySection, {})))

    expect(container.textContent).toContain('96.8%')
    // Nothing to report is not the same as reporting "unchanged": a card that
    // always showed a cause would put "contents changed" on every single turn.
    expect(container.textContent).not.toContain(zh.cacheMiss)
    expect(container.textContent).not.toContain(zh.cacheMissIdle)
  })

  it('says so when no request has reported usage yet', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: statusPayload() })) as typeof fetch

    await act(async () => root.render(createElement(AntigravitySection, {})))

    // Null is "nothing measured", not a 0% ratio: the card must not draw a meter
    // for a request that never ran.
    expect(container.textContent).toContain(zh.cacheEmpty)
    expect(container.textContent).not.toContain(zh.cacheHitRatio)
  })
})
