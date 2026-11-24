// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { RelayOneSection } from '../src/client/relayone/RelayOneSection.tsx'
import { selectRelayOneBadgeFacts } from '../src/client/relayone/RelayOneComposerQuota.tsx'
import { BrandTile } from '../src/client/hub/brand-icons.tsx'
import { installRelayOneStyles, STYLE_ID } from '../src/client/relayone/styles.ts'
import { RELAYONE_PROVIDER_ID, type RelayOneStatusDto } from '../src/shared/relayone-contracts.ts'

function status(overrides: Partial<RelayOneStatusDto> = {}): RelayOneStatusDto {
  return {
    providerId: RELAYONE_PROVIDER_ID, enabled: true, authenticated: true, storagePath: 'encrypted',
    accounts: [], rotationStrategy: 'sequential',
    models: [{ id: 'gpt-6-astra', name: 'gpt-6-astra', kind: 'chat', hint: 'OpenAI · Responses · openai', enabled: true, groups: ['openai'], endpoints: ['openai'], protocol: 'openai-responses', vendor: 'OpenAI', description: null, contextWindow: 256000, defaultContextWindow: 256000, maxOutputTokens: 32768, reasoningEfforts: ['low', 'medium', 'high'], supportsImages: true }],
    mediaModels: [{ id: 'image-one', name: 'image-one', kind: 'image', hint: 'OpenAI · Media · images', enabled: false, groups: ['images'], endpoints: ['image-generation'], protocol: null, vendor: 'OpenAI', description: null, contextWindow: 128000, defaultContextWindow: 128000, maxOutputTokens: 8192, reasoningEfforts: [], supportsImages: false }],
    contextWindowOverrides: {}, defaultReasoningEffort: null, imageModel: null, videoModel: null,
    catalog: { state: 'ready', fetchedAt: 1, error: null, groups: ['openai', 'images'] },
    quota: { state: 'idle', totalGranted: null, totalUsed: null, totalAvailable: null, remainingPercent: null, quotaPerUnit: null, expiresAt: null, fetchedAt: null, error: null },
    serving: true, conflict: null,
    ...overrides,
  }
}
let container: HTMLDivElement
let root: Root
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
function mockFetch(initial: RelayOneStatusDto) {
  let current = initial
  const calls: Array<{ url: string; body?: unknown }> = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    let body: unknown
    if (typeof init?.body === 'string') body = JSON.parse(init.body)
    calls.push({ url, ...(body === undefined ? {} : { body }) })
    if (url.endsWith('/relayone/api/settings') && typeof body === 'object' && body !== null) {
      const patch = body as Record<string, unknown>
      if (Array.isArray(patch.enabledModelIds)) {
        const selected = patch.enabledModelIds as string[]
        current = { ...current, models: current.models.map(model => ({ ...model, enabled: selected.includes(model.id) })) }
      }
      return Response.json({ ok: true, value: current })
    }
    if (url.includes('/relayone/api/')) return Response.json({ ok: true, value: current })
    return Response.json({ ok: true, value: { lineProxies: {}, noProxy: null, detectedProxy: null, activeProxies: {} } })
  }) as typeof fetch
  return calls
}
async function render() {
  await act(async () => root.render(createElement(RelayOneSection)))
}

describe('RelayOne settings section', () => {
  it('uses the shared card skeleton with at most two account heading actions', async () => {
    mockFetch(status())
    await render()
    expect(container.querySelector('.dsha-page[data-provider="relayone"]')).not.toBeNull()
    expect(container.querySelectorAll('.dsha-group').length).toBeGreaterThanOrEqual(6)
    expect(container.querySelectorAll('.dshro-account .dsha-grouphead button')).toHaveLength(2)
    expect(container.textContent).toContain('gpt-6-astra')
    expect(container.textContent).toContain('OpenAI · Responses · openai')
    expect(container.querySelector('.dshro-media select')).not.toBeNull()
    // The line now rotates several keys, so the shared account-pool card is
    // part of this skeleton; it used to be absent when the line held one key.
    expect(container.textContent).toContain('API Key 号池')
  })
  it('shows actionable signed-out and empty-media states without fake counts', async () => {
    mockFetch(status({ authenticated: false, models: [], mediaModels: [], catalog: { state: 'idle', fetchedAt: null, error: null, groups: [] } }))
    await render()
    expect(container.textContent).toContain('尚未配置 API Key')
    expect(container.textContent).toContain('配置 Key 后自动发现模型')
    expect(container.textContent).toContain('当前 Key 没有可用媒体模型')
    expect(container.querySelectorAll('.dshro-account .dsha-grouphead button')).toHaveLength(1)
  })
  it('commits an explicit all-off selection through the shared checklist', async () => {
    const calls = mockFetch(status())
    await render()
    const clear = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '清空')!
    await act(async () => clear.click())
    expect(calls.some(call => call.url.endsWith('/relayone/api/settings') && JSON.stringify(call.body) === '{"enabledModelIds":[]}')).toBe(true)
  })
  it('lists every pooled key with its identity, state and rotation strategy', async () => {
    mockFetch(status({
      accounts: [
        { id: 'acc_a', alias: '主号', isPrimary: true, lastUsedAt: 1 },
        { id: 'acc_b', alias: '备号', isPrimary: false, cooldownUntil: Date.now() + 120_000, cooldownReason: 'RelayOne 429' },
      ],
      activeAccountId: 'acc_a',
      rotationStrategy: 'round-robin',
    }))
    await render()
    const rows = container.querySelectorAll('.dsha-account-card')
    expect(rows.length).toBe(2)
    expect(container.textContent).toContain('主号')
    expect(container.textContent).toContain('备号')
    // A resting key says so.
    expect(container.textContent).toContain('冷却中')
    // This line switches keys by hand, so no rotation-strategy picker is drawn:
    // offering round-robin over a manual selection would promise a rotation that
    // never happens.
    expect(container.textContent).not.toContain('调度策略')
    // The key that is NOT active offers the switch; the active one does not.
    const switches = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .filter(button => button.textContent === '切换到此 Key')
    expect(switches).toHaveLength(1)
  })

  it('switches the active key through the pool route', async () => {
    const calls = mockFetch(status({
      accounts: [
        { id: 'acc_a', alias: '主号', isPrimary: true },
        { id: 'acc_b', alias: '备号', isPrimary: false },
      ],
      activeAccountId: 'acc_a',
    }))
    await render()
    const switchButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '切换到此 Key')!
    await act(async () => switchButton.click())
    expect(calls.find(call => call.url.endsWith('/relayone/api/accounts'))?.body)
      .toMatchObject({ action: 'use', accountId: 'acc_b' })
  })

  it('adds a key through the pool route rather than the single-key route', async () => {
    const calls = mockFetch(status())
    await render()
    const input = [...container.querySelectorAll<HTMLInputElement>('input[type="password"]')][0]!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'sk-second')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const add = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存密钥')!
    await act(async () => add.click())
    const posted = calls.find(call => call.url.endsWith('/relayone/api/accounts'))
    expect(posted?.body).toMatchObject({ action: 'add', apiKey: 'sk-second' })
  })

  it('does not blank the section while an old host omits quota', async () => {
    const legacy = status()
    delete (legacy as unknown as Record<string, unknown>).quota
    mockFetch(legacy)
    await render()
    expect(container.querySelector('.dshro-account')).not.toBeNull()
    expect(container.textContent).toContain('RelayOne')
  })
  it('renders a 500K override as separate metadata instead of renaming the model', async () => {
    const base = status()
    mockFetch(status({
      contextWindowOverrides: { 'gpt-6-astra': 500000 },
      models: base.models.map(model => ({ ...model, contextWindow: 500000 })),
    }))
    await render()
    const meta = container.querySelector('.dshro-model-meta')
    expect(meta?.textContent).toBe('500K')
    expect(meta?.previousSibling?.textContent).not.toBe('gpt-6-astra500K')
  })
  it('badge hides until quota exists, then shows text without a progress meter', () => {
    expect(selectRelayOneBadgeFacts(status())).toBeNull()
    const facts = selectRelayOneBadgeFacts(status({ quota: {
      state: 'ready', totalGranted: 1000000, totalUsed: 250000, totalAvailable: 750000,
      remainingPercent: 75, quotaPerUnit: 500000, expiresAt: null, fetchedAt: 1, error: null,
    } }))
    expect(facts).toMatchObject({ text: '75%', level: 'normal' })
    expect(facts).not.toHaveProperty('percent')
    expect(facts?.tooltip).toContain('$1.500')
  })
  it('pins a full-width key grid and the shared style ownership tag', () => {
    installRelayOneStyles()
    const style = document.getElementById(STYLE_ID)
    expect(style?.textContent).toContain('grid-template-columns:minmax(0,1fr) auto')
    expect(style?.textContent).toContain('max-width:none')
    expect(style?.textContent).toContain('.dshro-model-meta')
    expect(style?.getAttribute('data-plugin-css')).toBe('@eddyskywalker/dsh-chatgpt-subscription/relayone')
  })
  it('renders the official RelayOne artwork rather than a monogram', () => {
    const markup = renderToStaticMarkup(<BrandTile id="relayone" />)
    expect(markup).toContain('data:image/svg+xml;base64,')
    expect(markup).toContain('dsh-hub-brand-image')
    expect(markup).not.toContain('dsh-hub-brand-mono')
  })
})
