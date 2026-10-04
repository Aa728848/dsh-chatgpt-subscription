// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CodexSubscriptionSection, FetchProviderStatusCard } from '../src/client/CodexSubscriptionSection.tsx'
import { zh } from '../src/client/locales.ts'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

const t = ((key: keyof typeof zh) => zh[key]) as never

/** A host that reports the full fetch diagnostics, as the current route does. */
const fullStatus = (overrides: Record<string, unknown> = {}): unknown => ({
  switcher: {
    state: 'applied',
    configuredSearchProvider: 'deepseek-official',
    configuredFetchProvider: 'codex-subscription',
  },
  fetchConfiguration: {
    fetchProvider: 'auto',
    fetchMaxBodyChars: 100_000,
    fetchMaxResponseBytes: 2_097_152,
  },
  ...overrides,
})

describe('fetch provider status card', () => {
  it('shows the configured provider, switcher state, mode and plugin limits the host reported', () => {
    const html = renderToStaticMarkup(<FetchProviderStatusCard status={fullStatus() as never} t={t} />)
    expect(html).toContain(zh.fetchStatus)
    expect(html).toContain('codex-subscription')
    expect(html).toContain(zh.switcherStateApplied)
    expect(html).toContain('auto')
    expect(html).toContain('100000')
    expect(html).toContain('2097152')
    expect(html).toContain(zh.fetchConfigSource)
    expect(html).toContain('data-fetch-status="applied"')
  })

  it('translates every switcher state rather than showing the raw enum', () => {
    for (const [state, label] of [
      ['idle', zh.switcherStateIdle],
      ['applying', zh.switcherStateApplying],
      ['applied', zh.switcherStateApplied],
      ['missing', zh.switcherStateMissing],
      ['failed', zh.switcherStateFailed],
    ] as const) {
      const html = renderToStaticMarkup(<FetchProviderStatusCard status={fullStatus({
        switcher: { state, configuredSearchProvider: null, configuredFetchProvider: null },
      }) as never} t={t} />)
      expect(html).toContain(label)
      expect(html).toContain(`data-fetch-status="${state}"`)
    }
  })

  /**
   * The load-bearing distinction: a reported `null` is the host saying it pinned
   * no provider, while no `switcher` at all means the host said nothing. The
   * second must not borrow the first's label.
   */
  it('reads a reported null provider as the DSH default and an absent switcher as unknown', () => {
    const reported = renderToStaticMarkup(<FetchProviderStatusCard status={fullStatus({
      switcher: { state: 'idle', configuredSearchProvider: null, configuredFetchProvider: null },
    }) as never} t={t} />)
    expect(reported).toContain(zh.fetchProviderDshDefault)
    expect(reported).not.toContain('codex-subscription')

    const absent = renderToStaticMarkup(<FetchProviderStatusCard status={{ fetchConfiguration: { fetchProvider: 'auto', fetchMaxBodyChars: 100_000, fetchMaxResponseBytes: 2_097_152 } } as never} t={t} />)
    expect(absent).not.toContain(zh.fetchConfiguredProvider)
    expect(absent).not.toContain(zh.fetchProviderDshDefault)
    expect(absent).not.toContain(zh.switcherState)
    // The mode it did report is still shown.
    expect(absent).toContain(zh.fetchModeAuto)

    const nullSwitcher = renderToStaticMarkup(<FetchProviderStatusCard status={fullStatus({ switcher: null }) as never} t={t} />)
    expect(nullSwitcher).not.toContain(zh.fetchConfiguredProvider)
    expect(nullSwitcher).toContain(zh.fetchModeAuto)
  })

  it('flags the limits as plugin-fetch-only for auto and dsh alike', () => {
    for (const mode of ['auto', 'dsh'] as const) {
      const html = renderToStaticMarkup(<FetchProviderStatusCard status={fullStatus({
        fetchConfiguration: { fetchProvider: mode, fetchMaxBodyChars: 100_000, fetchMaxResponseBytes: 2_097_152 },
      }) as never} t={t} />)
      expect(html).toContain(zh.fetchLimitsInactive)
      expect(html).toContain('100000')
    }
    const plugin = renderToStaticMarkup(<FetchProviderStatusCard status={fullStatus({
      fetchConfiguration: { fetchProvider: 'plugin', fetchMaxBodyChars: 100_000, fetchMaxResponseBytes: 2_097_152 },
    }) as never} t={t} />)
    expect(plugin).not.toContain(zh.fetchLimitsInactive)
  })

  it('never prints a proxy URL, even when the status carries one', () => {
    const html = renderToStaticMarkup(<FetchProviderStatusCard status={fullStatus({
      detectedProxy: 'http://127.0.0.1:7890',
      activeProxy: 'http://user:secret@127.0.0.1:7890',
    }) as never} t={t} />)
    expect(html).not.toContain('127.0.0.1')
    expect(html).not.toContain('http')
  })

  it('drops rows a host could not have meant, and renders nothing at all without either block', () => {
    const garbage = renderToStaticMarkup(<FetchProviderStatusCard status={{
      switcher: { state: 'weird', configuredFetchProvider: '' },
      fetchConfiguration: { fetchProvider: 'nope', fetchMaxBodyChars: 0, fetchMaxResponseBytes: 1.5 },
    } as never} t={t} />)
    expect(garbage).not.toContain(zh.switcherState)
    expect(garbage).toContain(zh.fetchProviderDshDefault)
    expect(garbage).not.toContain(zh.fetchMode)
    expect(garbage).not.toContain(zh.fetchMaxBodyChars)

    // A host predating the feature sends neither block: no card, no crash.
    expect(renderToStaticMarkup(<FetchProviderStatusCard status={{} as never} t={t} />)).toBe('')
    expect(renderToStaticMarkup(<FetchProviderStatusCard status={null} t={t} />)).toBe('')
    expect(renderToStaticMarkup(<FetchProviderStatusCard status={undefined} t={t} />)).toBe('')
  })
})

describe('search source wording', () => {
  it('names the setting the search source and points at the auto fetch mode', () => {
    expect(zh.searchProvider).toBe('搜索来源')
    expect(zh.searchProvider).not.toContain('抓取')
    expect(zh.searchProviderHint).toContain('auto')
    expect(zh.searchProviderHint).toContain('跟随')
  })
})

/**
 * Mount the tab over a fake host, the way the settings page does, so the card is
 * checked in its real place: after the search-source selector it belongs to.
 */
async function mountSection(status: Record<string, unknown>): Promise<{ container: HTMLElement; teardown: () => Promise<void> }> {
  const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
  const originalFetch = globalThis.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: {
    authenticated: false,
    account: null,
    storage: { kind: 'memory', encrypted: false, available: true },
    login: { active: false, loginId: null, expiresAt: null },
    quota: { state: 'signed-out', buckets: [], credits: null, individualLimit: null, spendControlReached: null, resetCredits: null, fetchedAt: null, stale: false },
    preferences: {
      quickQuotaVisible: false,
      fastMode: false,
      outputVerbosity: null,
      reasoningSummary: null,
      visibleModelIds: ['gpt-5.6-sol'],
      searchProvider: 'dsh',
      contextWindowOverrides: {},
      proxyMode: 'auto',
      customProxyUrl: null,
      writable: true,
    },
    ...status,
  } })) as typeof fetch
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(createElement(CodexSubscriptionSection, { t } as never)))
  return {
    container,
    teardown: async () => {
      await act(async () => root.unmount())
      container.remove()
      globalThis.fetch = originalFetch
      globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
    },
  }
}

describe('fetch status in the settings tab', () => {
  it('renders below the search source selector when the host reports the blocks', async () => {
    const harness = await mountSection(fullStatus() as Record<string, unknown>)
    try {
      const { container } = harness
      const card = container.querySelector('[data-fetch-status]')
      expect(card).not.toBeNull()
      const groups = container.querySelector('.dsh-codex-segments')
      expect(groups).not.toBeNull()
      expect(groups!.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(container.textContent).toContain('codex-subscription')
      expect(container.textContent).toContain(zh.switcherStateApplied)
      expect(container.textContent).toContain('2097152')
    } finally {
      await harness.teardown()
    }
  })

  it('still renders the whole tab on a host that reports neither block', async () => {
    const harness = await mountSection({})
    try {
      const { container } = harness
      expect(container.querySelector('[data-fetch-status]')).toBeNull()
      expect(container.textContent).toContain(zh.searchProvider)
      expect(container.querySelector('.dsh-codex-segments')).not.toBeNull()
    } finally {
      await harness.teardown()
    }
  })
})
