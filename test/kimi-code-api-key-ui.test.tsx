// @vitest-environment jsdom
/**
 * The Kimi Code card's second way in: a pasted membership API key.
 *
 * Pins the heading (exactly the device-code button and the key toggle), the key
 * field living below the list rather than in the heading, the request body the
 * card posts, that the key does not stay in the page, and that re-signing-in an
 * API-key row opens the key field instead of starting a device-code flow.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KimiCodeWebStatus } from '../src/shared/kimi-code-contracts.ts'
import { KimiCodeSection } from '../src/client/kimi-code/KimiCodeSection.tsx'
import { zh } from '../src/client/kimi-code/locales.ts'
import { STYLE_ID, installKimiCodeStyles } from '../src/client/kimi-code/styles.ts'

function status(overrides: Partial<KimiCodeWebStatus> = {}): KimiCodeWebStatus {
  return {
    enabled: true,
    authenticated: true,
    hasCredentials: true,
    storagePath: '/tmp/kimi.json',
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    codingBaseUrl: 'https://api.kimi.com/coding',
    account: null,
    quota: null,
    lastFetchedAt: null,
    credentialsRejected: false,
    cache: null,
    preserveThinking: false,
    models: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    loginRegion: 'mainland-cn',
    serving: true,
    conflict: null,
    rotationStrategy: 'sequential',
    accounts: [
      { id: 'acc_oauth', alias: 'dev@example.com', isPrimary: true, authKind: 'oauth' },
      { id: 'acc_key', alias: '工作 Key', isPrimary: false, authKind: 'api-key', authStatus: 'expired', authFailedReason: 'revoked' },
    ],
    activeAccountId: 'acc_oauth',
    ...overrides,
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let realFetch: typeof fetch | undefined
let posts: Array<{ url: string; body: unknown }> = []

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
  })
}

function accountHead(node: HTMLElement): HTMLElement {
  return [...node.querySelectorAll<HTMLElement>('.dsha-grouphead')].find((head) => head.textContent?.includes(zh.accountPool))!
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  posts = []
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  realFetch ??= globalThis.fetch
  vi.stubGlobal('open', vi.fn())
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string }).url ?? input)
    if (init?.method === 'POST') posts.push({ url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
    if (url.endsWith('/kimi-code/api/status')) return Response.json({ ok: true, value: status() })
    if (url.endsWith('/kimi-code/api/login/api-key')) return Response.json({ ok: true, value: status() })
    if (url.endsWith('/kimi-code/api/login')) return Response.json({ ok: true, value: { status: 'pending' } })
    return Response.json({ ok: true, value: { preferences: null } })
  }) as unknown as typeof fetch
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root !== null) await act(async () => root!.unmount())
  root = null
  container?.remove()
  container = null
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  if (realFetch !== undefined) globalThis.fetch = realFetch
  vi.unstubAllGlobals()
})

async function mount(): Promise<HTMLElement> {
  await act(async () => { root!.render(createElement(KimiCodeSection)) })
  await settle()
  return container!
}

describe('Kimi Code API-key sign-in', () => {
  it('offers exactly two entries in the heading, with the key field closed', async () => {
    const node = await mount()
    const buttons = [...accountHead(node).querySelectorAll('button')].map((button) => button.textContent)
    expect(buttons).toEqual([zh.addAccount, zh.apiKeyLogin])
    expect(node.querySelector('#dshkc-apikey-body')).toBeNull()
    // The row says how it signs in.
    expect(node.textContent).toContain(`${zh.authMethod}: ${zh.authMethodApiKey}`)
  })

  it('posts the pasted key and clears it from the page', async () => {
    const node = await mount()
    const toggle = [...accountHead(node).querySelectorAll('button')].find((button) => button.textContent === zh.apiKeyLogin)!
    await act(async () => { toggle.click() })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const body = node.querySelector<HTMLElement>('#dshkc-apikey-body')!
    expect(body.closest('.dsha-grouphead')).toBeNull()
    const input = body.querySelector('input')!
    expect(input.type).toBe('password')
    await act(async () => { typeInto(input, '  sk-kimi-secret ') })
    const submit = [...body.querySelectorAll('button')].find((button) => button.textContent === zh.apiKeySubmit)!
    await act(async () => { submit.click() })
    await settle()
    expect(posts.filter((post) => post.url.endsWith('/login/api-key')).map((post) => post.body)).toEqual([{ apiKey: 'sk-kimi-secret' }])
    expect(node.querySelector('#dshkc-apikey-body')).toBeNull()
    expect(node.innerHTML).not.toContain('sk-kimi-secret')
  })

  it('lets the key field span the row instead of the 220px picker cap', () => {
    installKimiCodeStyles()
    const css = document.getElementById(STYLE_ID)?.textContent ?? ''
    expect(css).toContain('.dsha-select{')
    expect(css).toMatch(/\.dshkc-apikey-row input\.dsha-select\{[^}]*flex:1 1 auto[^}]*max-width:none/)
  })

  it('re-signing-in an API-key row opens the key field bound to that row', async () => {
    const node = await mount()
    const card = [...node.querySelectorAll<HTMLElement>('.dsha-account-card')].find((entry) => entry.textContent?.includes('工作 Key'))!
    const relogin = [...card.querySelectorAll('button')].find((button) => button.textContent === zh.relogin)!
    await act(async () => { relogin.click() })
    await settle()
    // No device-code flow and no relogin action were started for it.
    expect(posts.some((post) => post.url.endsWith('/kimi-code/api/login') || post.url.endsWith('/accounts'))).toBe(false)
    const body = node.querySelector<HTMLElement>('#dshkc-apikey-body')!
    expect(body.textContent).toContain(zh.apiKeyReplaceHint.replace('{alias}', '工作 Key'))
    await act(async () => { typeInto(body.querySelector('input')!, 'sk-kimi-new') })
    const submit = [...body.querySelectorAll('button')].find((button) => button.textContent === zh.apiKeySubmit)!
    await act(async () => { submit.click() })
    await settle()
    expect(posts.find((post) => post.url.endsWith('/login/api-key'))?.body).toEqual({ apiKey: 'sk-kimi-new', accountId: 'acc_key' })
  })
})
