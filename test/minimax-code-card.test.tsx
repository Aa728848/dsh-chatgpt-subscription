// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MinimaxCodeSection } from '../src/client/minimax-code/MinimaxCodeSection.tsx'
import { zh } from '../src/client/minimax-code/locales.ts'

describe('MiniMax Code card: sibling parity controls', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
  })

  function mockFetch(overrides: { enabled?: boolean; accounts?: unknown[] } = {}) {
    const calls: Array<{ url: string; body?: unknown }> = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) })
      if (url.includes('/accounts')) {
        return Response.json({ ok: true, value: {
          accounts: overrides.accounts ?? [],
          rotationStrategy: 'sequential',
        } })
      }
      return Response.json({ ok: true, value: {
        enabled: overrides.enabled ?? true,
        authenticated: false,
        account: null,
        region: 'cn',
        storage: { kind: 'file', path: '/tmp/c.json' },
        models: [
          { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', enabled: true, defaultContextWindow: 200_000, contextWindow: 200_000, defaultMaxTokens: 128_000, thinking: 'always-on', description: 'x' },
          { id: 'MiniMax-M3', name: 'MiniMax M3', enabled: true, defaultContextWindow: 200_000, contextWindow: 200_000, defaultMaxTokens: 128_000, thinking: 'toggle', description: 'flagship' },
        ],
        contextWindowOverrides: {},
        defaultReasoningEffort: null,
        serving: true,
        conflict: null,
        ownedByPlugin: false,
      } })
    }) as typeof fetch
    return calls
  }

  async function render() {
    await act(async () => root.render(createElement(MinimaxCodeSection, {})))
  }

  it('renders the model grid and the context-window controls', async () => {
    mockFetch()
    await render()
    const text = container.textContent ?? ''
    // The controls every sibling line has, minus the provider switch, which
    // lives on the overview card now.
    expect(text).toContain(zh.modelsSection)
    expect(text).toContain(zh.contextWindowSection)
    expect(text).toContain(zh.defaultReasoningEffort)
    // No literal key leaked into the rendered output.
    for (const key of ['contextWindowSection', 'selectAll', 'enhanced']) {
      expect(text).not.toContain(key)
    }
    // One checklist row per model, each labelled with the model's display name.
    const rows = [...container.querySelectorAll('.dsh-mcl-option .dsh-mcl-name')].map((el) => el.textContent)
    expect(rows).toContain('MiniMax M2.7')
    expect(rows).toContain('MiniMax M3')
  })

  it('sends the narrowed selection to /models when a model is unchecked', async () => {
    const calls = mockFetch()
    await render()
    const row = [...container.querySelectorAll('.dsh-mcl-option')].find((el) => el.textContent?.includes('MiniMax M3'))! as HTMLButtonElement
    expect(row.getAttribute('aria-checked')).toBe('true')
    await act(async () => { row.click() })
    const modelsCall = calls.find((c) => c.url.includes('/models') && c.body !== undefined)
    expect(modelsCall?.body).toEqual({ enabledModelIds: ['MiniMax-M2.7'] })
  })

  it('shows the shared account-management card once the pool answers', async () => {
    mockFetch({ accounts: [{ id: 'a1', alias: 'me@example.com', isPrimary: true, removable: true }] })
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain(zh.accountPool)
    expect(text).toContain('me@example.com')
  })
})
