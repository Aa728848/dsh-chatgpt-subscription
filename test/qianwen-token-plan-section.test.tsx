// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { QianwenTokenPlanSection } from '../src/client/qianwen-token-plan/QianwenTokenPlanSection.tsx'
import { selectQianwenBadgeFacts } from '../src/client/qianwen-token-plan/QianwenComposerQuota.tsx'
import { qianwenCacheHitRatio } from '../src/client/qianwen-token-plan/useQianwenSection.ts'
import { BrandTile } from '../src/client/hub/brand-icons.tsx'
import { catalogModelOptions } from '../src/host/qianwen-token-plan/model-catalog.ts'
import { defaultQianwenSettings } from '../src/host/qianwen-token-plan/token-store.ts'
import { QIANWEN_TOKEN_PLAN_PROVIDER_ID, type QianwenStatusDto } from '../src/shared/qianwen-token-plan-contracts.ts'

function makeStatus(): QianwenStatusDto {
  const settings = defaultQianwenSettings()
  return {
    providerId: QIANWEN_TOKEN_PLAN_PROVIDER_ID, enabled: true, authenticated: false, hasCredentials: false,
    storagePath: 'Keychain: test', models: catalogModelOptions(settings), contextWindowOverrides: {},
    defaultReasoningEffort: null, cacheEnabled: true, cacheTtl: '5m', thinkingSummary: true,
    imageDetail: 'auto', maxPixels: null, serving: true, conflict: null,
  }
}
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let current: QianwenStatusDto
const originalFetch = globalThis.fetch
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  current = makeStatus()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/qianwen-token-plan/api/')) {
      const method = init?.method ?? 'GET'
      if (url.endsWith('/credentials') && method === 'PUT') current = { ...current, authenticated: true, hasCredentials: true }
      if (url.endsWith('/credentials') && method === 'DELETE') current = { ...current, authenticated: false, hasCredentials: false }
      if (url.endsWith('/settings') && method === 'POST') {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>
        current = { ...current, ...patch }
        if (Array.isArray(patch.enabledModelIds)) {
          const selected = patch.enabledModelIds as string[]
          current.models = current.models.map(model => ({ ...model, enabled: selected.includes(model.id) }))
        }
      }
      if (url.endsWith('/connection')) return Response.json({ ok: true, value: { connected: true, latencyMs: 1, model: 'qwen4-max', checkedAt: Date.now() } })
      return Response.json({ ok: true, value: current })
    }
    return Response.json({ ok: true, value: { lineProxies: {}, noProxy: null, detectedProxy: null, activeProxies: {} } })
  }) as typeof fetch
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch
})
async function render() { await act(async () => root.render(<QianwenTokenPlanSection />)) }
function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Qwen Token Plan settings UI', () => {
  it('renders a single-key card, all reasoning levels, both TTLs and no account-pool/quota fabrication', async () => {
    await render()
    expect(container.querySelector('.dshqw-account')).not.toBeNull()
    expect(container.querySelector('.dsha-account')).toBeNull()
    expect(container.querySelectorAll('.dshqw-account .dsha-grouphead button')).toHaveLength(1)
    const efforts = [...container.querySelectorAll('select')].find(node => node.getAttribute('aria-label') === '默认推理档位')
    expect([...efforts!.querySelectorAll('option')].map(option => option.getAttribute('value'))).toEqual(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    const ttl = [...container.querySelectorAll('select')].find(node => node.getAttribute('aria-label') === '缓存 TTL')
    expect([...ttl!.querySelectorAll('option')].map(option => option.getAttribute('value'))).toEqual(['5m', '1h'])
    expect(container.textContent).not.toMatch(/剩余 Credits[:：]?\s*\d/)
  })
  it('saves a key only in the credential request body and refreshes the public status', async () => {
    await render()
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => setInput(input, 'sk-sp-test-secret'))
    await act(async () => container.querySelector<HTMLButtonElement>('.dshqw-key-row button')!.click())
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) => String(url).endsWith('/credentials'))
    expect(call?.[1]?.method).toBe('PUT')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ apiKey: 'sk-sp-test-secret' })
    expect(container.textContent).not.toContain('sk-sp-test-secret')
    expect(container.textContent).toContain('已配置套餐专属 API Key')
  })
  it('submits the user-selected TTL and exact reasoning level without auto adjustment', async () => {
    await render()
    const ttl = [...container.querySelectorAll('select')].find(node => node.getAttribute('aria-label') === '缓存 TTL')!
    await act(async () => { ttl.value = '1h'; ttl.dispatchEvent(new Event('change', { bubbles: true })) })
    const effort = [...container.querySelectorAll('select')].find(node => node.getAttribute('aria-label') === '默认推理档位')!
    await act(async () => { effort.value = 'minimal'; effort.dispatchEvent(new Event('change', { bubbles: true })) })
    const bodies = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).endsWith('/settings')).map(call => JSON.parse(String(call[1]?.body)))
    expect(bodies).toContainEqual({ cacheTtl: '1h' })
    expect(bodies).toContainEqual({ defaultReasoningEffort: 'minimal' })
  })
  it('keeps an explicitly empty model selection as all-off', async () => {
    await render()
    const clear = [...container.querySelectorAll<HTMLButtonElement>('.dsh-mcl-action')].find(button => button.textContent === '全不选')!
    await act(async () => clear.click())
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]) => String(url).endsWith('/settings'))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ enabledModelIds: [] })
    expect(container.querySelectorAll('.dsh-mcl-option[aria-checked="true"]')).toHaveLength(0)
  })
  it('renders no local stats block for a zero cache denominator and no composer badge', async () => {
    current.cacheStats = { requests: 1, missedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0, reasoningTokens: 0, encryptedReplays: 0, missingEncryptedContent: 0 }
    expect(qianwenCacheHitRatio(current.cacheStats)).toBeNull()
    expect(selectQianwenBadgeFacts(current)).toBeNull()
    await render()
    expect(container.querySelector('.dshqw-stats')).toBeNull()
    expect(container.querySelector('.dshqw-cache .dsha-grouphead button')).toBeNull()
    expect(container.querySelector('.dshqw-cache')?.textContent).not.toContain('0%')
    expect(container.querySelector('.dshqw-cache')?.textContent).not.toContain('缓存命中率')
  })
  it('uses the official Qianwen image and no monogram', () => {
    const markup = renderToStaticMarkup(<BrandTile id="qianwen-token-plan" />)
    expect(markup).toContain('data:image/png;base64,')
    expect(markup).not.toContain('dsh-hub-brand-mono')
  })
})
