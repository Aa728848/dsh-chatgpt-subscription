// @vitest-environment jsdom
/**
 * The Claude subscription card and its composer badge.
 *
 * Two behaviours here are the reason this file exists at all, and both are
 * structural rather than cosmetic:
 *
 * 1. NO CONTROL ON THE CARD IS HELD BACK. The sign-in, import, model and quota
 *    controls render ENABLED against a plain status with nothing acknowledged,
 *    and a click reaches the host route — asserted positively, because "not
 *    disabled" alone would also hold for a control wired to nothing;
 * 2. the badge reads `utilization` in the right DIRECTION — the wire reports
 *    PERCENT USED, so the tightest REMAINING window is the interesting one and a
 *    0%-used window is the normal empty state, not an error.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeWebStatus } from '../src/shared/claude-contracts.ts'
import { ClaudeSection, formatCapacity, parsePositiveCapacity } from '../src/client/claude/ClaudeSection.tsx'
import { ClaudeComposerQuota, selectBadgeFacts } from '../src/client/claude/ClaudeComposerQuota.tsx'
import { dictionaries, en, NS_CLAUDE, zh } from '../src/client/claude/locales.ts'
import { accountPoolZh } from '../src/client/common/account-pool-labels.ts'

const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT

/** A signed-in status: two windows, a weekly one tighter than the 5-hour one. */
function status(overrides: Partial<ClaudeWebStatus> = {}): ClaudeWebStatus {
  return {
    enabled: true,
    authenticated: true,
    hasCredentials: true,
    storagePath: 'DPAPI: /tmp/claude-credentials.json.dpapi',
    serving: true,
    conflict: null,
    claudeCodeSignInAvailable: true,
    claudeCodePaths: ['C:/Users/u/.claude/.credentials.json'],
    account: { email: 'user@example.com', subscriptionType: 'max' },
    quota: {
      windows: [
        {
          id: 'five_hour', label: '5-hour', windowMinutes: 300,
          usedFraction: 0.2, usedPercent: 20, remainingPercent: 80,
          resetsAt: new Date(Date.now() + 3_600_000).toISOString(), source: 'usage',
        },
        {
          id: 'seven_day', label: 'Weekly (7 days)', windowMinutes: 10_080,
          usedFraction: 0.71, usedPercent: 71, remainingPercent: 29,
          resetsAt: new Date(Date.now() + 86_400_000).toISOString(), source: 'usage',
        },
      ],
      extraUsage: null,
      fetchedAt: Date.now(),
      observedAt: Date.now(),
      status: null,
      representativeClaim: null,
    },
    lastFetchedAt: Date.now(),
    quotaError: null,
    models: [
      {
        id: 'claude-opus-4-6', name: 'Claude Opus 4.6', enabled: true,
        defaultContextWindow: 200_000, contextWindow: 200_000, defaultMaxTokens: 32_768,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        canDisableThinking: true, thinkingMode: 'adaptive', supportsImage: true, supportsTemperature: true,
      },
      {
        id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', enabled: false,
        defaultContextWindow: 200_000, contextWindow: 200_000, defaultMaxTokens: 32_768,
        reasoningEfforts: [], canDisableThinking: false, thinkingMode: 'none',
        supportsImage: false, supportsTemperature: true,
      },
    ],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    selectedAccountId: null,
    accounts: [
      {
        id: 'claude:primary', alias: 'user@example.com', isPrimary: true,
        email: 'user@example.com', planLabel: 'max', subscriptionType: 'max',
        source: 'managed', adopted: false,
      },
    ],
    activeAccountId: 'claude:primary',
    rotationStrategy: 'sequential',
    ...overrides,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
/**
 * The real fetch, put back after each test.
 *
 * The mock stays installed for the WHOLE test rather than only for the render:
 * the card resolves `fetch` at call time, so restoring it right after mounting
 * would send every click's request to the real one and record nothing.
 */
let realFetch: typeof fetch | undefined

/** Mount the card over a fetch mock that records every request. */
async function mountSection(
  payload: ClaudeWebStatus,
  respond?: (url: string, init?: RequestInit) => Response | undefined,
): Promise<{ node: HTMLDivElement; fetchMock: ReturnType<typeof vi.fn> }> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  realFetch ??= globalThis.fetch
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const custom = respond?.(url, init)
    if (custom !== undefined) return custom
    return Response.json({ ok: true, value: payload })
  })
  globalThis.fetch = fetchMock as typeof fetch
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(ClaudeSection, {})))
  return { node: container, fetchMock }
}

beforeEach(() => {
  // jsdom has no window.open; the card calls it for the flow's authorize URL.
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

describe('claude card with nothing held back', () => {
  it('renders every section and leaves every control enabled', async () => {
    const { node } = await mountSection(status())

    // The account pool is the first section: the notice block that used to sit
    // above it is gone, and no element on the page carries its class prefix.
    const first = node.querySelector('.dsha-page')?.firstElementChild
    expect(first?.className).not.toContain('consent')
    expect(node.querySelector('[class*="consent"]')).toBeNull()
    // The sections that must survive the removal are all still rendered.
    expect(node.querySelector('.dsha-models')).not.toBeNull()
    expect(node.querySelector('.dsha-quota-card')).not.toBeNull()

    // The controls the gate used to disable are live, which is the property the
    // removal is about.
    const signIn = node.querySelector<HTMLButtonElement>(`button[aria-label="${zh.signIn}"]`)
    const importButton = node.querySelector<HTMLButtonElement>(`button[aria-label="${zh.importClaudeCode}"]`)
    expect(signIn).not.toBeNull()
    expect(importButton).not.toBeNull()
    expect(signIn?.disabled).toBe(false)
    expect(importButton?.disabled).toBe(false)
    // No locked-reason tooltip is attached either: it went with the gate.
    expect(signIn?.getAttribute('title')).toBeNull()
    const modelInput = node.querySelector<HTMLInputElement>('.dsha-models input[type="checkbox"]')
    expect(modelInput?.disabled).toBe(false)
  })

  it('starts a sign-in from the click, with no acknowledgement step in front of it', async () => {
    const { node, fetchMock } = await mountSection(status(), (url) => (
      url.endsWith('/claude/api/login') ? Response.json({ ok: true, value: { status: 'pending' } }) : undefined
    ))

    await act(async () => {
      node.querySelector<HTMLButtonElement>(`button[aria-label="${zh.signIn}"]`)?.click()
    })

    // The positive half: the click reaches the host route rather than being
    // swallowed by a disabled control or a card-side gate.
    const call = fetchMock.mock.calls.find((entry) => String(entry[0]).endsWith('/claude/api/login'))
    expect(call).toBeDefined()
    expect(call?.[1]?.method).toBe('POST')
    expect(fetchMock.mock.calls.some((entry) => String(entry[0]).includes('/consent'))).toBe(false)
  })
})

describe('claude model and context settings', () => {
  it('posts the enabled model ids the toggles produce', async () => {
    const { node, fetchMock } = await mountSection(status())

    // Opus is checked, Haiku is not.
    const labels = [...node.querySelectorAll('.dsha-models label')]
    expect(labels.map((label) => label.textContent)).toEqual(['Claude Opus 4.6', 'Claude Haiku 4.5'])
    const haiku = labels[1]!.querySelector('input')!
    await act(async () => haiku.click())

    const call = fetchMock.mock.calls.find((entry) => String(entry[0]).endsWith('/claude/api/models'))
    expect(call).toBeDefined()
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      enabledModelIds: ['claude-opus-4-6', 'claude-haiku-4-5'],
    })
  })

  it('offers every catalog reasoning level, xhigh included', async () => {
    const { node } = await mountSection(status())
    const select = node.querySelector<HTMLSelectElement>(`.dsha-select[aria-label="${zh.defaultReasoningEffort}"]`)
    expect(select).not.toBeNull()
    expect([...select!.options].map((option) => option.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('posts a number to save a context window and null to restore the default', async () => {
    const { node, fetchMock } = await mountSection(status({
      contextWindowOverrides: { 'claude-opus-4-6': 500_000 },
      models: status().models.map((model) => model.id === 'claude-opus-4-6'
        ? { ...model, contextWindow: 500_000 }
        : model),
    }))

    const input = node.querySelector<HTMLInputElement>(`input[aria-label="Claude Opus 4.6 context window"]`)
    expect(input?.value).toBe('500K')

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '1M')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      node.querySelector<HTMLButtonElement>('.dsha-context-row .dsha-context-save')?.click()
    })
    let call = fetchMock.mock.calls.find((entry) => String(entry[0]).endsWith('/claude/api/settings'))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      contextWindowOverrides: { 'claude-opus-4-6': 1_000_000 },
    })

    // 'Restore default' sends null, which is the host's "delete this override"
    // and survives the route's own normalization.
    const reset = node.querySelector<HTMLButtonElement>(
      `button[aria-label="Claude Opus 4.6 ${zh.contextWindowReset}"]`,
    )
    expect(reset?.disabled).toBe(false)
    await act(async () => reset?.click())
    const settingsCalls = fetchMock.mock.calls.filter((entry) => String(entry[0]).endsWith('/claude/api/settings'))
    expect(JSON.parse(String(settingsCalls[settingsCalls.length - 1]?.[1]?.body))).toEqual({
      contextWindowOverrides: { 'claude-opus-4-6': null },
    })
  })
})

/** Mount the composer badge over a directory store pinned to one provider. */
async function mountBadge(
  provider: string,
  payload: ClaudeWebStatus,
): Promise<{ node: HTMLDivElement; fetchMock: ReturnType<typeof vi.fn> }> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  realFetch ??= globalThis.fetch
  const fetchMock = vi.fn(async () => Response.json({ ok: true, value: payload }))
  globalThis.fetch = fetchMock as typeof fetch
  const state = { current: { provider, model: 'x' }, models: [] }
  const store = {
    subscribe: () => () => undefined,
    getSnapshot: () => state,
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(ClaudeComposerQuota, {
    directory: store,
    loadModelDirectory: () => undefined,
  } as never)))
  return { node: container, fetchMock }
}

describe('claude composer badge', () => {
  it('picks the TIGHTEST window, which is the weekly one here', () => {
    const facts = selectBadgeFacts(status())
    // The 5-hour window has 80% left and the weekly one 29%; the weekly is tighter.
    expect(facts?.text).toBe('29%')
    expect(facts?.tooltip).toContain('Weekly (7 days)')
    expect(facts?.level).toBe('normal')

    const tight = selectBadgeFacts(status({
      quota: {
        ...status().quota!,
        windows: [{ ...status().quota!.windows[0]!, usedPercent: 96, remainingPercent: 4 }],
      },
    }))
    expect(tight?.level).toBe('danger')

    const warning = selectBadgeFacts(status({
      quota: {
        ...status().quota!,
        windows: [{ ...status().quota!.windows[0]!, usedPercent: 85, remainingPercent: 15 }],
      },
    }))
    expect(warning?.level).toBe('warning')
  })

  it('reads 0% used as the normal empty state, not as an error', () => {
    const facts = selectBadgeFacts(status({
      quota: {
        ...status().quota!,
        windows: [
          { ...status().quota!.windows[0]!, usedPercent: 0, remainingPercent: 100, usedFraction: 0 },
          { ...status().quota!.windows[1]!, usedPercent: 0, remainingPercent: 100, usedFraction: 0 },
        ],
      },
    }))
    expect(facts?.text).toBe('100%')
    expect(facts?.level).toBe('normal')
  })

  it('is active only for the claude-subscription provider and forces a refresh on click', async () => {
    const active = await mountBadge('claude-subscription', status())
    const span = active.node.querySelector('.dsha-composer-quota')
    expect(span).not.toBeNull()
    // The weekly window (29% left) is tighter than the 5-hour one (80% left).
    expect(active.node.textContent).toContain('29%')
    expect(span?.getAttribute('aria-label')).toContain('Weekly (7 days)')
    await act(async () => span?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const refresh = active.fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/claude/api/quota'))
    expect(refresh).toBeDefined()
    expect(refresh?.[1]?.method).toBe('POST')

    // Another provider's model is selected, so this line contributes nothing.
    const other = await mountBadge('kimi-code', status())
    expect(other.node.querySelector('.dsha-composer-quota')).toBeNull()
    expect(other.fetchMock).not.toHaveBeenCalled()
  })

  it('reports unavailable rather than zero when a window states nothing', () => {
    expect(selectBadgeFacts(null)?.text).toBe('—')
    const unknown = selectBadgeFacts(status({
      quota: {
        ...status().quota!,
        windows: [{ ...status().quota!.windows[0]!, usedPercent: null, remainingPercent: null, usedFraction: null }],
      },
    }))
    expect(unknown?.text).toBe('—')
  })
})

describe('claude card helpers and locales', () => {
  it('parses and formats a capacity a user would actually type', () => {
    expect(parsePositiveCapacity('1M')).toBe(1_000_000)
    expect(parsePositiveCapacity('512k')).toBe(512_000)
    expect(parsePositiveCapacity('200_000')).toBe(200_000)
    expect(parsePositiveCapacity('0')).toBeNull()
    expect(parsePositiveCapacity('lots')).toBeNull()
    expect(formatCapacity(1_000_000)).toBe('1M')
    expect(formatCapacity(512_000)).toBe('512K')
    expect(formatCapacity(131_072)).toBe('131072')
  })

  it('carries every shared account-pool label in both dictionaries', () => {
    for (const key of Object.keys(accountPoolZh)) {
      expect(zh).toHaveProperty(key)
      expect(en).toHaveProperty(key)
    }
    // The key sets are identical, so a string added to one language cannot be
    // silently missing from the other.
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(dictionaries.zh).toBe(zh)
    expect(dictionaries['en-US']).toBe(en)
    expect(NS_CLAUDE).toBe('dsh-claude')
  })
})
