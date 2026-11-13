// @vitest-environment jsdom
/**
 * The Antigravity (ACP) settings card.
 *
 * The properties asserted here are the ones a later reviewer would otherwise
 * break silently: there is no account-pool card (the official CLI owns the
 * sign-in), no invented quota percentage, and the model list is the shared
 * checklist rather than a second one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AntigravityAcpSection } from '../src/client/antigravity-acp/AntigravityAcpSection.tsx'

const STATUS = {
  binary: { kind: 'local-cli', path: '/usr/local/bin/agy', version: '1.5.3' },
  auth: { authenticated: true, method: 'oauth-personal', tier: { id: 't', name: 'Google AI Ultra' } },
  models: [
    { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: ['low', 'medium', 'high'] },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B', efforts: [] },
  ],
  enabledModelIds: null,
  defaultReasoningEffort: null,
  permissionPolicy: 'reject',
  catalogSynced: true,
  usage: { inputTokens: 9084, outputTokens: 34, cacheReadTokens: 0, at: 1 },
}

describe('AntigravityAcpSection', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, value: STATUS })))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('renders without an account-pool card, because this line owns no accounts', async () => {
    await act(async () => root.render(createElement(AntigravityAcpSection, {})))
    // The shared account card is what a pooled line renders; this line must not
    // grow one to "look like the others" - there is no pool behind it.
    expect(container.querySelector('.dsha-accounts-list')).toBeNull()
    expect(container.textContent).toContain('Antigravity（ACP）')
  })

  it('shows the published model ladder and no fabricated quota percentage', async () => {
    await act(async () => root.render(createElement(AntigravityAcpSection, {})))
    expect(container.querySelectorAll('.dsh-mcl-option')).toHaveLength(2)
    expect(container.textContent).toContain('low / medium / high')
    expect(container.textContent).not.toMatch(/\d+\s*%/)
  })

  it('names the executable and the plan the server reported', async () => {
    await act(async () => root.render(createElement(AntigravityAcpSection, {})))
    const text = container.textContent ?? ''
    expect(text).toContain('本机 Antigravity CLI')
    expect(text).toContain('1.5.3')
    expect(text).toContain('Google AI Ultra')
    expect(text).toContain('已登录')
  })

  it('states the ACP boundaries rather than leaving the user to discover them', async () => {
    await act(async () => root.render(createElement(AntigravityAcpSection, {})))
    const text = container.textContent ?? ''
    expect(text).toContain('ACP 没有独立的 system 提示槽位')
    expect(text).toContain('官方服务端不公布剩余额度')
  })
})
