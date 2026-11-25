// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { OpenCodeGoSection } from '../../src/client/providers/opencode-go/OpenCodeGoSection.tsx'
import type { OpenCodeGoWebStatus } from '../../src/shared/opencode-go-contracts.ts'

const quotaUrl = '/opencode-go/api/quota/refresh'
const status = {
  enabled: true, providerId: 'opencode-go', serving: true, conflict: null, authenticated: true,
  accounts: [{ id: 'account', alias: 'Example', isPrimary: true, authKind: 'api-key' }],
  activeAccountId: 'account', rotationStrategy: 'sequential', selectedAccountId: null,
  models: [{
    id: 'model', name: 'Example model', hint: '', enabled: true, defaultContextWindow: 128_000,
    contextWindow: 128_000, defaultMaxTokens: 4096, reasoningEfforts: [], supportsTools: true,
    supportsImages: false, description: null, canonicalId: null, training: null, zdr: null, limitedRegions: null,
  }],
  contextWindowOverrides: {}, defaultReasoningEffort: null, catalogSynced: true, catalogCount: 1,
  quotaError: null, connection: null,
} satisfies OpenCodeGoWebStatus

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify({ ok: true, value }))
}

describe('OpenCode Go quota refresh', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
  let hidden: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    fetchMock = vi.fn<typeof fetch>(async input => jsonResponse(input === '/opencode-go/api/status' ? status : { lineProxies: {}, activeProxies: {} }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  }

  function quotaCalls() {
    return fetchMock.mock.calls.filter(([url]) => url === quotaUrl)
  }

  it('refreshes after 30 seconds, updates the quota, and preserves an edited context window', async () => {
    const refreshed = jsonResponse({
      ...status,
      accounts: [{ ...status.accounts[0], quota: { fetchedAt: Date.now(), windows: [{ usedPercent: 27, resetsAt: null, windowDurationMins: 43_200 }] } }],
    })
    await act(async () => root.render(createElement(OpenCodeGoSection)))
    const context = container.querySelector<HTMLInputElement>('input[aria-label="Example model"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(context, '160K')
      context.dispatchEvent(new Event('input', { bubbles: true }))
    })
    fetchMock.mockResolvedValueOnce(refreshed)
    await advance(29_999)
    expect(quotaCalls()).toHaveLength(0)
    await advance(1)
    expect(quotaCalls()).toHaveLength(1)
    expect(quotaCalls()[0]?.[1]?.method).toBe('POST')
    expect(container.querySelector('.dshoc-quota')?.textContent).toContain('27%')
    expect(context.value).toBe('160K')
  })

  it('skips hidden windows and does not overlap a pending refresh', async () => {
    await act(async () => root.render(createElement(OpenCodeGoSection)))
    hidden.mockReturnValue(true)
    await advance(30_000)
    expect(quotaCalls()).toHaveLength(0)
    hidden.mockReturnValue(false)
    let resolve!: (response: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>(done => { resolve = done }))
    await advance(60_000)
    expect(quotaCalls()).toHaveLength(1)
    await act(async () => resolve(jsonResponse(status)))
    fetchMock.mockResolvedValueOnce(jsonResponse(status))
    await advance(30_000)
    expect(quotaCalls()).toHaveLength(2)
  })
})
