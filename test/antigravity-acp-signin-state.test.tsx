// @vitest-environment jsdom
/**
 * The settings card's SIGNED-IN presentation.
 *
 * The bug this file pins: the card said "已登录" in body copy while the only
 * action still read "登录 Google 账号", and nothing reported the result of a
 * sign-in attempt - so a user could not tell whether they were signed in or
 * whether the click had done anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AntigravityAcpSection } from '../src/client/antigravity-acp/AntigravityAcpSection.tsx'

function status(authenticated: boolean) {
  return {
    enabled: true,
    binary: { kind: 'local-cli', path: '/usr/local/bin/agy', version: '1.5.3' },
    auth: authenticated
      ? { authenticated: true, method: 'oauth-personal', tier: { id: 't', name: 'Google AI Ultra' } }
      : { authenticated: false },
    models: [{ id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: ['low'] }],
    enabledModelIds: null,
    defaultReasoningEffort: null,
    permissionPolicy: 'reject',
    catalogSynced: true,
  }
}

describe('AntigravityAcpSection sign-in state', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('shows a signed-in badge and offers "sign in again" instead of "sign in"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, value: status(true) })))
    await act(async () => root.render(createElement(AntigravityAcpSection, {})))
    const text = container.textContent ?? ''
    // The badge says signed in...
    expect(container.querySelector('.dsha-badge.active')?.textContent).toBe('已登录')
    // ...and the action agrees with it.
    const buttons = [...container.querySelectorAll('button')].map((button) => button.textContent?.trim())
    expect(buttons).toContain('重新登录')
    expect(buttons).not.toContain('登录 Google 账号')
  })

  it('shows a signed-out badge and offers the sign-in action', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, value: status(false) })))
    await act(async () => root.render(createElement(AntigravityAcpSection, {})))
    expect(container.querySelector('.dsha-badge.danger')?.textContent).toBe('未登录')
    const buttons = [...container.querySelectorAll('button')].map((button) => button.textContent?.trim())
    expect(buttons).toContain('登录 Google 账号')
  })

  it('reports the outcome of a sign-in attempt', async () => {
    let signedIn = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/login/start')) {
        signedIn = true
        return Response.json({ ok: true, value: { started: true } })
      }
      return Response.json({ ok: true, value: status(signedIn) })
    })
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => root.render(createElement(AntigravityAcpSection, {})))
    const signIn = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '登录 Google 账号')
    expect(signIn).toBeDefined()
    await act(async () => {
      signIn!.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('已发起登录')
  })

  it('keeps the long explanation collapsed instead of stacking paragraphs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, value: status(true) })))
    await act(async () => root.render(createElement(AntigravityAcpSection, {})))
    const details = [...container.querySelectorAll<HTMLDetailsElement>('details.dshagy-details')]
    // One collapsed block per prose-heavy section: sign-in, runtime, usage, boundaries.
    expect(details.length).toBeGreaterThanOrEqual(4)
    // Collapsed by default: the sentence exists in the DOM but takes no space.
    expect(details.every((entry) => entry.open === false)).toBe(true)
    expect(container.textContent).toContain('登录是怎么完成的？')
  })
})
