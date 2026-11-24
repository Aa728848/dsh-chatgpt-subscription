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
import { AntigravityAcpSection } from '../../../src/client/providers/antigravity-acp/AntigravityAcpSection.tsx'

const STATUS = {
  enabled: true,
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

  it('offers the built-in-tool policy with the permissive option selected', async () => {
    await act(async () => root.render(createElement(AntigravityAcpSection, {})))
    const labels = [...container.querySelectorAll('select')]
      .map((select) => select.getAttribute('aria-label'))
    // Both switches exist and are distinct: "tool permissions" answers the agent's
    // own permission requests, this one decides what happens when the agent runs a
    // tool of its own. Merging them was the bug the issue reported.
    expect(labels).toContain('自带工具')
    expect(labels).toContain('工具权限')
    const native = [...container.querySelectorAll('select')]
      .find((select) => select.getAttribute('aria-label') === '自带工具')
    expect(native?.value).toBe('allow')
    const text = container.textContent ?? ''
    expect(text).toContain('记录并继续')
    expect(text).toContain('立即取消整轮')
  })

  it('does not claim a sign-in state it never checked while the line is off', async () => {
    // The disabled status omits the probe entirely, so `authenticated: false` there
    // means "not asked", not "signed out". A red signed-out badge would be a claim
    // the host never made.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      ok: true,
      value: { ...STATUS, enabled: false, binary: { kind: 'missing' }, auth: { authenticated: false }, models: [] },
    })))
    await act(async () => root.render(createElement(AntigravityAcpSection, {})))
    const text = container.textContent ?? ''
    expect(text).toContain('线路已停用，未查询登录状态')
    expect(text).not.toContain('未登录')
    // The runtime row is the same story: the executable was never resolved, so
    // "not found" would be a diagnostic nobody ran.
    expect(text).toContain('线路已停用，未检测运行环境')
    expect(text).not.toContain('未找到可用的 agy')
  })

  it('states the ACP boundaries rather than leaving the user to discover them', async () => {
    await act(async () => root.render(createElement(AntigravityAcpSection, {})))
    const text = container.textContent ?? ''
    expect(text).toContain('ACP 没有独立的 system 提示槽位')
    expect(text).toContain('官方服务端不公布剩余额度')
  })

  it('offers a restore-automatic button that clears the configured executable path', async () => {
    // The catalog already ships a "restore automatic resolution" label; the card
    // used to render only "save path", so the reset wording was dead. The user
    // action that matters is the request body: a null path tells the host to go
    // back to resolving the executable itself.
    const requests: { url: string; body: string | null }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { body?: string | null }) => {
      requests.push({ url: String(input), body: init?.body ?? null })
      return Response.json({ ok: true, value: STATUS })
    }))
    await act(async () => root.render(createElement(AntigravityAcpSection, {})))
    const button = [...container.querySelectorAll('button')]
      .find((entry) => entry.textContent === '恢复自动查找')
    expect(button).toBeDefined()
    await act(async () => { button?.click() })
    const patch = requests.find((entry) => entry.url === '/antigravity-acp/api/settings')
    expect(patch).toBeDefined()
    expect(JSON.parse(patch?.body ?? 'null')).toEqual({ binaryPath: null })
  })
})
