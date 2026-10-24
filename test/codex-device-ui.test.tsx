// @vitest-environment jsdom
/**
 * The device-code panel the ChatGPT card opens for a headless host.
 *
 * The host side has its own suite (`codex-device-login.test.ts`); this one is
 * about what the user sees: the code big enough to copy, the page to type it on,
 * a countdown that actually counts, a Cancel that ends the flow, and — the part
 * most easily got wrong — an error that leaves the panel open instead of taking
 * the code away.
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexSubscriptionSection } from '../src/client/CodexSubscriptionSection.tsx'
import { zh } from '../src/client/locales.ts'
import { ROUTE_PREFIX } from '../src/compat.ts'

const t = ((key: keyof typeof zh) => zh[key]) as never

const STATUS = `${ROUTE_PREFIX}/status`
const DEVICE_START = `${ROUTE_PREFIX}/login/device/start`
const LOGIN_CANCEL = `${ROUTE_PREFIX}/login/cancel`

const harness: { container?: HTMLElement; teardown?: () => Promise<void> } = {}
const originalFetch = globalThis.fetch
const originalEventSource = globalThis.EventSource

/** The SSE stand-in: records the listeners the card attaches, so a test can fire them. */
class FakeEventSource {
  static current: FakeEventSource | null = null
  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>()
  closed = false
  constructor(readonly url: string) {
    FakeEventSource.current = this
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, payload: unknown): void {
    // A real host ends the flow on any terminal event (its `activeLogin` is
    // empty afterwards, which is what the status route then reports). The fake
    // has to do the same, or a test can model a host that cannot exist: one that
    // has published `failed` and still offers a login id to cancel.
    if (type !== 'pending') FakeEventSource.onTerminal?.()
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(payload) } as MessageEvent<string>)
    }
  }

  /** Set by `mount`: forgets the running flow, as the host does on a terminal event. */
  static onTerminal: (() => void) | null = null
}

beforeEach(() => {
  globalThis.EventSource = FakeEventSource as never
  // jsdom has no clipboard; the panel must work with one, and (see the last test
  // in this file) must not fall over without one either.
  written.length = 0
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { written.push(text) } },
  })
})

/** What the panel actually put on the clipboard, in order. */
const written: string[] = []

afterEach(async () => {
  await harness.teardown?.()
  delete harness.teardown
  delete harness.container
  globalThis.fetch = originalFetch
  globalThis.EventSource = originalEventSource
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  Reflect.deleteProperty(navigator, 'clipboard')
  FakeEventSource.onTerminal = null
})

const codexStatus = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  authenticated: false,
  account: null,
  storage: { kind: 'memory', encrypted: false, available: true },
  login: { active: false, loginId: null, expiresAt: null },
  quota: {
    state: 'signed-out', buckets: [], credits: null, individualLimit: null,
    spendControlReached: null, resetCredits: null, fetchedAt: null, stale: false,
  },
  preferences: {
    quickQuotaVisible: false, fastMode: false, outputVerbosity: null, reasoningSummary: null,
    visibleModelIds: ['gpt-5.6-sol'], searchProvider: 'dsh', contextWindowOverrides: {},
    proxyMode: 'auto', customProxyUrl: null, writable: true,
  },
  accounts: [],
  activeAccountId: null,
  rotationStrategy: 'sequential',
  ...overrides,
})

interface Call { url: string; method: string; body?: unknown }

/**
 * Mount the card. `device` is the answer the device route gives.
 *
 * `holdDevice` leaves the device route unanswered until the returned
 * `releaseDevice` is called — the state a second click has to be judged in.
 */
async function mount(device: { status?: number; body: unknown } = {
  body: { loginId: 'device-1', userCode: 'ABCD-EFGH', verificationUrl: 'https://auth.openai.com/codex/device', expiresAt: Math.floor(Date.now() / 1000) + 900, now: Math.floor(Date.now() / 1000) },
}, options: { holdDevice?: boolean } = {}): Promise<Call[] & { releaseDevice?: () => Promise<void> }> {
  const calls: Call[] = []
  const result = calls as Call[] & { releaseDevice?: () => Promise<void> }
  // The host's view of the running sign-in, which the status route reports. It is
  // what the card's Cancel reads the flow id from, exactly as in production.
  let login: Record<string, unknown> = { active: false, loginId: null, expiresAt: null }
  // The host forgets the flow the moment it publishes a terminal event, so the
  // status route below reports no active login from then on.
  FakeEventSource.onTerminal = () => {
    login = { active: false, loginId: null, expiresAt: null }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) })
    if (url === DEVICE_START) {
      if (device.status !== undefined) {
        return Response.json({ ok: false, error: device.body }, { status: device.status })
      }
      login = { active: true, loginId: 'device-1', expiresAt: (device.body as { expiresAt: number }).expiresAt }
      if (options.holdDevice === true) {
        return new Promise<Response>((resolve) => {
          result.releaseDevice = async () => {
            await act(async () => resolve(Response.json({ ok: true, value: device.body })))
          }
        })
      }
      return Response.json({ ok: true, value: device.body })
    }
    if (url === LOGIN_CANCEL) {
      login = { active: false, loginId: null, expiresAt: null }
      return Response.json({ ok: true, value: { cancelled: true } })
    }
    return Response.json({ ok: true, value: codexStatus({ login }) })
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
  return result
}

function deviceButton(): HTMLButtonElement {
  const row = harness.container!.querySelector<HTMLElement>('.dsha-account-add-actions')!
  return [...row.querySelectorAll<HTMLButtonElement>('button')][1]!
}

function panel(): HTMLElement | null {
  return harness.container!.querySelector<HTMLElement>('.dsh-codex-device')
}

/** The two copy buttons: first the one beside the code, then the one beside the link. */
function copyButtons(): HTMLButtonElement[] {
  return [...panel()!.querySelectorAll<HTMLButtonElement>('.dsh-codex-copy')]
}

async function openPanel(): Promise<void> {
  await act(async () => deviceButton().click())
  await act(async () => Promise.resolve())
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('the ChatGPT device-code panel', () => {
  it('shows the code, the confirmation page and a countdown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await mount()
      await openPanel()

      const box = panel()
      expect(box).not.toBeNull()
      // The code is its own element, so the user can read and copy exactly it.
      expect(box!.querySelector('.dsh-codex-device-code')!.textContent).toBe('ABCD-EFGH')
      // Where to type it, as a real link.
      const link = box!.querySelector<HTMLAnchorElement>('a')!
      expect(link.getAttribute('href')).toBe('https://auth.openai.com/codex/device')
      expect(link.textContent).toBe(zh.deviceCodeOpen)
      // The countdown, from the grant's own deadline: about 15 minutes. Both
      // ends of the host's pair are whole seconds, so the remaining time lands
      // within a second of 900 — the exact value depends on how much of a
      // second passed between the answer and the first render, which is not the
      // behaviour worth pinning. What is: it starts near the grant lifetime.
      const waiting = zh.deviceCodeWaiting.replace('{time}', '')
      const readRemaining = (): number => {
        const match = new RegExp(`${escapeRegExp(waiting)}(\\d+):(\\d\\d)`).exec(panel()!.textContent ?? '')
        expect(match).not.toBeNull()
        return Number(match![1]) * 60 + Number(match![2])
      }
      const initial = readRemaining()
      expect(initial).toBeGreaterThanOrEqual(895)
      expect(initial).toBeLessThanOrEqual(900)
      await act(async () => { vi.advanceTimersByTime(61_000) })
      // It moves: a minute of wall clock takes a minute off the countdown, which
      // is what proves the panel is a clock and not a snapshot.
      const later = readRemaining()
      expect(later).toBeGreaterThanOrEqual(initial - 62)
      expect(later).toBeLessThanOrEqual(initial - 60)
      // Cancel is on the panel, not only in the card's shared action row.
      expect([...box!.querySelectorAll('button')].map((button) => button.textContent))
        .toContain(zh.cancel)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes the panel and re-reads the status once the account is confirmed', async () => {
    const calls = await mount()
    await openPanel()
    expect(panel()).not.toBeNull()

    await act(async () => FakeEventSource.current!.emit('completed', { type: 'completed', loginId: 'device-1' }))
    await act(async () => Promise.resolve())

    expect(panel()).toBeNull()
    // The account is read back from the host rather than assumed from the event.
    expect(calls.filter((call) => call.url === STATUS).length).toBeGreaterThan(1)
  })

  it('counts the remaining time on the host clock, not the browser one', async () => {
    // A remote host whose clock is an hour ahead of this browser — the situation
    // the whole device-code path exists for. The grant is 15 minutes out on the
    // HOST's clock, so the panel must show about 15 minutes, not 75.
    const hostNow = Math.floor(Date.now() / 1000)
    await mount({
      body: {
        loginId: 'device-1',
        userCode: 'ABCD-EFGH',
        verificationUrl: 'https://auth.openai.com/codex/device',
        expiresAt: hostNow + 3_600 + 900,
        now: hostNow + 3_600,
      },
    })
    await openPanel()

    const waiting = zh.deviceCodeWaiting.replace('{time}', '')
    expect(panel()!.textContent).toMatch(new RegExp(`${escapeRegExp(waiting)}14:5\\d`))
  })

  it('cannot be clicked a second time while its own request is in flight', async () => {
    const calls = await mount(undefined as never, { holdDevice: true })

    await act(async () => deviceButton().click())
    // The request has not answered yet, and the button is already out of reach:
    // a second click would be a second grant, and the host would then have lost
    // the first flow's Cancel for the rest of its lifetime.
    expect(deviceButton().disabled).toBe(true)
    expect(deviceButton().textContent).toBe(zh.deviceCodeLoginStarting)
    await act(async () => deviceButton().click())
    await act(async () => Promise.resolve())
    expect(calls.filter((call) => call.url === DEVICE_START)).toHaveLength(1)

    await calls.releaseDevice!()
    expect(panel()).not.toBeNull()
    // The button comes back: the wait belongs to the panel now, and its own
    // Cancel is what ends it.
    expect(deviceButton().disabled).toBe(false)
    expect(calls.filter((call) => call.url === DEVICE_START)).toHaveLength(1)
  })

  it('keeps the panel open with the failure on it, so the code is not lost', async () => {
    await mount()
    await openPanel()

    await act(async () => FakeEventSource.current!.emit('failed', {
      type: 'failed',
      loginId: 'device-1',
      error: { code: 'login-expired', message: 'The device code expired before it was confirmed.' },
    }))
    await act(async () => Promise.resolve())

    const box = panel()
    expect(box).not.toBeNull()
    expect(box!.textContent).toContain('The device code expired before it was confirmed.')
    // Still the same code on screen: the user can read it again or start over.
    expect(box!.querySelector('.dsh-codex-device-code')!.textContent).toBe('ABCD-EFGH')
    expect(box!.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('closes the panel when Cancel is pressed after a terminal failure', async () => {
    const calls = await mount()
    await openPanel()

    await act(async () => FakeEventSource.current!.emit('failed', {
      type: 'failed',
      loginId: 'device-1',
      error: { code: 'login-expired', message: 'The device code expired before it was confirmed.' },
    }))
    await act(async () => Promise.resolve())
    expect(panel()).not.toBeNull()

    const cancel = [...panel()!.querySelectorAll('button')].find((button) => button.textContent === zh.cancel)!
    await act(async () => cancel.click())
    await act(async () => Promise.resolve())

    // Nothing is running on the host any more, so Cancel is the panel's close
    // button: it must do something rather than return on a null flow id.
    expect(panel()).toBeNull()
    expect(harness.container!.querySelector('[role="alert"]')).toBeNull()
    expect(calls.some((call) => call.url === LOGIN_CANCEL)).toBe(false)
  })

  it('cancels from the panel: one call to the shared cancel route, then no panel', async () => {
    const calls = await mount()
    await openPanel()

    const cancel = [...panel()!.querySelectorAll('button')].find((button) => button.textContent === zh.cancel)!
    await act(async () => cancel.click())
    await act(async () => Promise.resolve())

    const cancellation = calls.find((call) => call.url === LOGIN_CANCEL)
    expect(cancellation?.method).toBe('POST')
    expect(cancellation?.body).toEqual({ loginId: 'device-1' })
    expect(panel()).toBeNull()
  })

  it('says why in the error strip when the host could not issue a code', async () => {
    await mount({ status: 400, body: { code: 'oauth-token-exchange-failed', message: 'The ChatGPT device code could not be issued (400, invalid_client).' } })
    await openPanel()

    // No panel to hold a reason, so the card's own strip carries it.
    expect(panel()).toBeNull()
    expect(harness.container!.querySelector('.dsh-codex-errorbar')!.textContent)
      .toContain('The ChatGPT device code could not be issued (400, invalid_client).')
  })
})

describe('the two copy controls on the device panel', () => {
  it('copies the code itself, with no spaces or line breaks', async () => {
    // The code arrives spaced out here on purpose: what goes on the clipboard is
    // the code, and a pasted value with a space in it is refused by the page.
    await mount({
      body: { loginId: 'device-1', userCode: 'ABCD EFGH', verificationUrl: 'https://auth.openai.com/codex/device', expiresAt: Math.floor(Date.now() / 1000) + 900, now: Math.floor(Date.now() / 1000) },
    })
    await openPanel()

    await act(async () => copyButtons()[0]!.click())
    await act(async () => Promise.resolve())

    expect(written).toEqual(['ABCDEFGH'])
    expect(written[0]).not.toMatch(/\s/)
  })

  it('copies the confirmation link from the button beside it', async () => {
    await mount()
    await openPanel()

    await act(async () => copyButtons()[1]!.click())
    await act(async () => Promise.resolve())

    expect(written).toEqual(['https://auth.openai.com/codex/device'])
  })

  it('draws both as the same control: same classes, same tooltip, same size', async () => {
    await mount()
    await openPanel()

    const [codeButton, linkButton] = copyButtons()
    expect(codeButton).toBeDefined()
    expect(linkButton).toBeDefined()
    // One class list for both — the size lives in that class, so two icons cannot
    // drift apart the way a per-spot style did.
    expect(codeButton!.className).toBe(linkButton!.className)
    expect(codeButton!.className).toBe('dsh-codex-copy')
    // The tooltip says the same thing in both places, and it names the action
    // rather than the value: the tick is the feedback, the affordance stays put.
    expect(codeButton!.title).toBe(zh.deviceCodeCopy)
    expect(linkButton!.title).toBe(zh.deviceCodeCopy)
    expect(codeButton!.getAttribute('aria-label')).toBe(zh.deviceCodeCopy)
    expect(linkButton!.getAttribute('aria-label')).toBe(zh.deviceCodeCopy)
  })

  it('leaves the panel open and asks for no second code', async () => {
    const calls = await mount()
    await openPanel()

    await act(async () => copyButtons()[0]!.click())
    await act(async () => copyButtons()[1]!.click())
    await act(async () => Promise.resolve())

    // Both values went to the clipboard, the panel is still there with the same
    // code on it, and the device route was asked exactly once — copying is not a
    // reason to start the flow again.
    expect(written).toHaveLength(2)
    expect(panel()).not.toBeNull()
    expect(panel()!.querySelector('.dsh-codex-device-code')!.textContent).toBe('ABCD-EFGH')
    expect(calls.filter((call) => call.url === DEVICE_START)).toHaveLength(1)
    expect(calls.some((call) => call.url === `${ROUTE_PREFIX}/login/start`)).toBe(false)
  })

  it('ticks for a moment and goes back, one value at a time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await mount()
      await openPanel()

      await act(async () => copyButtons()[0]!.click())
      await act(async () => Promise.resolve())
      expect(copyButtons()[0]!.dataset.copied).toBe('true')
      // The link's own icon did not react: they are two independent values.
      expect(copyButtons()[1]!.dataset.copied).toBe('false')
      expect(copyButtons()[0]!.querySelector('svg')).not.toBeNull()

      await act(async () => { vi.advanceTimersByTime(1_600) })
      expect(copyButtons()[0]!.dataset.copied).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does nothing at all when the host has no clipboard', async () => {
    Reflect.deleteProperty(navigator, 'clipboard')
    await mount()
    await openPanel()

    // No throw, no tick, no closed panel, and both values are still on screen to
    // be copied by hand.
    await act(async () => copyButtons()[0]!.click())
    await act(async () => Promise.resolve())

    expect(written).toEqual([])
    expect(panel()).not.toBeNull()
    expect(copyButtons()[0]!.dataset.copied).toBe('false')
  })
})
