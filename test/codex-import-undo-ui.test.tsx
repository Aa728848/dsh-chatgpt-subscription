// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSubscriptionSection } from '../src/client/CodexSubscriptionSection.tsx'
import { zh } from '../src/client/locales.ts'

const t = ((key: keyof typeof zh) => zh[key]) as never

const ADOPT_DISABLE = "/api/dsh-chatgpt-subscription/adopt/disable"

/** A managed account: this plugin signed it in, so the card may delete it. */
const managed = (id: string) => ({ id, alias: 'me@example.com', isPrimary: true })

/**
 * An imported account: a snapshot of a sign-in this plugin does not own.
 *
 * `removable: false` is the whole signal the shared summary DTO declares, and
 * it is what makes the shared card suppress Delete.
 */
const imported = (id: string) => ({ ...managed(id), removable: false })

const harness: { container?: HTMLElement; teardown?: () => Promise<void> } = {}

afterEach(async () => {
  await harness.teardown?.()
  delete harness.teardown
  delete harness.container
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
})

interface Call { url: string; method: string; body?: unknown }

/**
 * Mount the tab over a fake host, as test/fetch-provider-status-ui.test.tsx does,
 * so the control is checked in the pool it belongs to rather than in isolation.
 *
 * The pool is answered from `accounts` on every read, and the disable route
 * empties it, which is how the test can tell a reload from an optimistic guess.
 */
async function mount(accounts: unknown[]): Promise<Call[]> {
  const calls: Call[] = []
  let pool = accounts
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) })
    if (url === ADOPT_DISABLE) {
      // The host clears every imported row and ignores an accountId.
      pool = pool.filter((account) => (account as { removable?: boolean }).removable !== false)
      return Response.json({ ok: true, value: status(pool) })
    }
    return Response.json({ ok: true, value: status(pool) })
  }) as typeof fetch
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(createElement(CodexSubscriptionSection, { t } as never)))
  harness.container = container
  harness.teardown = async () => {
    await act(async () => root.unmount())
    container.remove()
  }
  return calls
}

function status(accounts: unknown[]): Record<string, unknown> {
  return {
    authenticated: accounts.length > 0,
    account: null,
    storage: { kind: 'memory', encrypted: false, available: true },
    login: { active: false, loginId: null, expiresAt: null },
    quota: { state: 'signed-out', buckets: [], credits: null, individualLimit: null, spendControlReached: null, resetCredits: null, fetchedAt: null, stale: false },
    preferences: {
      quickQuotaVisible: false, fastMode: false, outputVerbosity: null, reasoningSummary: null,
      visibleModelIds: ['gpt-5.6-sol'], searchProvider: 'dsh', contextWindowOverrides: {},
      proxyMode: 'auto', customProxyUrl: null, writable: true,
    },
    accounts,
    activeAccountId: (accounts[0] as { id?: string } | undefined)?.id ?? null,
    rotationStrategy: 'sequential',
  }
}

/** The one control that stops the import, found by what it does rather than where. */
function stopImportingButton(): HTMLButtonElement | null {
  return [...harness.container?.querySelectorAll<HTMLButtonElement>('.dsha-btn') ?? []]
    .find((button) => button.getAttribute('aria-label')?.startsWith(zh.stopImporting) ?? false) ?? null
}
describe('stopping the local sign-in import', () => {
  it('offers the undo for an imported row, which has no Delete of its own', async () => {
    await mount([managed('managed-1'), imported('adopted-1')])
    const cards = harness.container!.querySelectorAll('.dsha-account-card')
    expect(cards).toHaveLength(2)
    // The borrowed credential is not deletable, so its card shows no Delete…
    expect(cards[1]!.textContent).not.toContain(zh.deleteAccount)
    // …and the managed one still is.
    expect(cards[0]!.textContent).toContain(zh.deleteAccount)

    const stop = stopImportingButton()
    expect(stop).not.toBeNull()
    // It is a real <button>, so it is tab-reachable and Enter/Space activate it.
    expect(stop!.tagName).toBe('BUTTON')
    expect(stop!.disabled).toBe(false)
  })

  it('shows no stop-importing control while nothing is imported', async () => {
    await mount([managed('managed-1')])
    expect(stopImportingButton()).toBeNull()
    expect(harness.container!.textContent).not.toContain(zh.stopImporting)
  })

  it('sends no accountId, because the route clears every imported row at once', async () => {
    const calls = await mount([imported('adopted-1'), imported('adopted-2')])
    const stop = stopImportingButton()!
    expect(stop.getAttribute('aria-label')).toBe('停止导入全部本机登录（当前 2 个）')
    await act(async () => stop.click())

    const disable = calls.find((call) => call.url === ADOPT_DISABLE)
    expect(disable?.method).toBe('POST')
    expect(disable?.body).toEqual({})
    // The pool reloaded from the host's answer rather than being edited locally.
    expect(harness.container!.querySelectorAll('.dsha-account-card')).toHaveLength(0)
    expect(stopImportingButton()).toBeNull()
  })

  it('keeps the control out of reach of a managed account', async () => {
    const calls = await mount([managed('managed-1')])
    // The managed card's Delete still goes to the pool's own delete route.
    const remove = [...harness.container!.querySelectorAll<HTMLButtonElement>('.dsha-account-card button')]
      .find((button) => button.textContent === zh.deleteAccount)!
    await act(async () => remove.click())
    expect(calls.some((call) => call.url.endsWith('/accounts') && call.method === 'POST')).toBe(true)
    expect(calls.some((call) => call.url === ADOPT_DISABLE)).toBe(false)
  })

  it('disables itself while the request is in flight', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls: Call[] = []
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) })
      if (url === ADOPT_DISABLE) {
        await gate
        return Response.json({ ok: true, value: status([]) })
      }
      return Response.json({ ok: true, value: status([imported('adopted-1')]) })
    }) as typeof fetch
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    harness.container = container
    await act(async () => root.render(createElement(CodexSubscriptionSection, { t } as never)))
    harness.teardown = async () => { await act(async () => root.unmount()); container.remove() }

    await act(async () => stopImportingButton()!.click())
    expect(stopImportingButton()!.disabled).toBe(true)
    expect(stopImportingButton()!.textContent).toBe(zh.stopImportingBusy)
    release()
    await act(async () => { await gate })
    expect(stopImportingButton()).toBeNull()
  })

  it('surfaces a refusal in the existing error strip', async () => {
    const originalFetch = globalThis.fetch
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === ADOPT_DISABLE) {
        return Response.json({ ok: false, error: { code: 'bad-request', message: 'The ChatGPT account pool is not installed.' } }, { status: 400 })
      }
      return Response.json({ ok: true, value: status([imported('adopted-1')]) })
    }) as typeof fetch
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    harness.container = container
    harness.teardown = async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch }
    await act(async () => root.render(createElement(CodexSubscriptionSection, { t } as never)))

    await act(async () => stopImportingButton()!.click())
    await act(async () => Promise.resolve())
    // The host's sentence, not a kinder one: it is the party that knows why.
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('The ChatGPT account pool is not installed.')
    // The row survives a refused undo; it was never removed.
    expect(container.querySelectorAll('.dsha-account-card')).toHaveLength(1)
    expect(stopImportingButton()!.disabled).toBe(false)
  })
})
