// @vitest-environment jsdom
/**
 * Where a switch the user made wins against a status answer already in flight.
 *
 * The card polls /status on a timer and on tab focus, and every account action
 * answers with its own status document. A read issued BEFORE the switch can land
 * AFTER it, and applying that older document puts the previous account back on
 * screen — which reads as the pool having switched on its own. This pins the
 * guard: an older answer is discarded, a newer one still applies.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KimiCodeWebStatus } from '../src/shared/kimi-code-contracts.ts'
import { KimiCodeSection } from '../src/client/kimi-code/KimiCodeSection.tsx'

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
      { id: 'acc_a', alias: 'a@example.com', isPrimary: true },
      { id: 'acc_b', alias: 'b@example.com', isPrimary: false },
    ],
    activeAccountId: 'acc_a',
    ...overrides,
  }
}

/** What the host would answer before the switch: acc_a still serves. */
const beforeSwitch = status()
/** What the switch answer carries: acc_b is the choice now. */
const afterSwitch = status({
  accounts: [
    { id: 'acc_a', alias: 'a@example.com', isPrimary: false },
    { id: 'acc_b', alias: 'b@example.com', isPrimary: true },
  ],
  activeAccountId: 'acc_b',
})

let root: Root | null = null
let container: HTMLDivElement | null = null
let realFetch: typeof fetch | undefined
let holdNextStatus = false
let releaseHeld: ((payload: KimiCodeWebStatus) => void) | null = null

function activeTitle(node: HTMLElement): string {
  return node.querySelector<HTMLElement>('.dsha-account-card.active .dsha-account-title')?.textContent ?? '(none)'
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  holdNextStatus = false
  releaseHeld = null
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  realFetch ??= globalThis.fetch
  vi.stubGlobal('open', vi.fn())
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string }).url ?? input)
    if (url.endsWith('/kimi-code/api/status')) {
      if (holdNextStatus) {
        holdNextStatus = false
        return new Promise<Response>((resolve) => {
          releaseHeld = (payload) => resolve(Response.json({ ok: true, value: payload }))
        })
      }
      return Response.json({ ok: true, value: beforeSwitch })
    }
    if (url.endsWith('/kimi-code/api/accounts')) {
      return Response.json({ ok: true, value: afterSwitch })
    }
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
  realFetch = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('kimi-code: a stale status answer cannot undo a switch', () => {
  it('discards the answer a switch outdated, and still applies a later one', async () => {
    await act(async () => root!.render(createElement(KimiCodeSection, {})))
    await settle()
    expect(activeTitle(container!)).toBe('a@example.com')

    // A poll goes out and its answer is slow.
    holdNextStatus = true
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await settle()

    // The user switches in the meantime.
    const rows = [...container!.querySelectorAll<HTMLElement>('.dsha-account-card')]
    const target = rows.find((row) => row.querySelector('.dsha-account-title')?.textContent === 'b@example.com')!
    const button = [...target.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent === '设为主账号')!
    await act(async () => { button.click() })
    await settle()
    expect(activeTitle(container!)).toBe('b@example.com')

    // The pre-switch answer finally lands: it predates the choice and loses.
    expect(releaseHeld).not.toBeNull()
    await act(async () => { releaseHeld!(beforeSwitch) })
    await settle()
    expect(activeTitle(container!)).toBe('b@example.com')

    // The guard discards stale answers; it does not freeze the card. A fresh
    // poll is a NEW answer and still moves it.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await settle()
    expect(activeTitle(container!)).toBe('a@example.com')
  })
})
