// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSubscriptionSection } from '../src/client/CodexSubscriptionSection.tsx'
import { zh } from '../src/client/locales.ts'
import { ROUTE_PREFIX } from '../src/compat.ts'

const t = ((key: keyof typeof zh) => zh[key]) as never

const STATUS = `${ROUTE_PREFIX}/status`
const ADOPT = `${ROUTE_PREFIX}/adopt`

const harness: { container?: HTMLElement; teardown?: () => Promise<void> } = {}
const originalFetch = globalThis.fetch

afterEach(async () => {
  await harness.teardown?.()
  delete harness.teardown
  delete harness.container
  globalThis.fetch = originalFetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
})

interface Call { url: string; method: string; body?: unknown }

/** A managed account: this plugin signed it in, so the card may delete it. */
const managed = (id: string) => ({ id, alias: 'me@example.com', isPrimary: true })

/** A snapshot of a sign-in this plugin borrows rather than owns. */
const imported = (id: string) => ({ ...managed(id), removable: false })

/**
 * The ChatGPT status. The local sign-in flag is left out by default: it is an
 * optional DTO field, and the control under test must not depend on it.
 */
function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
  }
}

async function mount(options: {
  detected?: boolean
  adopt?: 'ok' | string
} = {}): Promise<Call[]> {
  const calls: Call[] = []
  let accounts: unknown[] = []
  const read = (): Record<string, unknown> => status({
    accounts,
    ...(options.detected === undefined ? {} : { codexCliSignInAvailable: options.detected }),
  })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) })
    if (url === ADOPT) {
      if (options.adopt !== undefined && options.adopt !== 'ok') {
        return Response.json({ ok: false, error: { code: 'bad-request', message: options.adopt } }, { status: 400 })
      }
      accounts = [...accounts, imported('adopted-1')]
      // The route answers with the POOL's status, which carries no sign-in flag.
      return Response.json({ ok: true, value: status({ accounts }) })
    }
    return Response.json({ ok: true, value: read() })
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

/**
 * The pool card's login row — the container the shared AccountPoolSection renders
 * INSTEAD of its own default button, and where the Claude section puts its import
 * button too. Asserting on this container is asserting the layout, not a
 * position that happens to look right today.
 */
function loginRow(): HTMLElement {
  const row = harness.container!.querySelector<HTMLElement>('.dsha-account-add-actions')
  expect(row).not.toBeNull()
  return row!
}

/** The two entries in the login row, in order. */
function loginRowButtons(): HTMLButtonElement[] {
  return [...loginRow().querySelectorAll<HTMLButtonElement>('button')]
}

/** The import button, the second entry: login first, then the other way in. */
function importButton(): HTMLButtonElement {
  const button = loginRowButtons()[1]
  expect(button).toBeDefined()
  return button!
}

describe('the local sign-in import button, beside the login button', () => {
  it('sits in the pool card login row, beside the login button', async () => {
    await mount()
    const buttons = loginRowButtons()
    // Exactly two entries, side by side — the login and the import. This is the
    // Claude layout, not a block of its own with a heading above it.
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.textContent).toBe(zh.addAccount)
    expect(buttons[1]!.textContent).toBe(zh.localCodexLoginImport)
  })

  it('keeps the login button primary and the import button secondary', async () => {
    await mount()
    const [login, importBtn] = loginRowButtons()
    // The shared card's default login button is primary; taking the row over
    // reproduces it rather than restyling it.
    expect(login!.className).toContain('dsha-btn-primary')
    expect(importBtn!.className).toContain('dsha-btn')
    // The import button must NOT claim to be the primary action, exactly as on
    // the Claude page.
    expect(importBtn!.className).not.toContain('dsha-btn-primary')
    expect(importBtn!.getAttribute('aria-label')).toBe(zh.localCodexLoginImport)
  })

  it('adds no heading, title or explanatory text of its own', async () => {
    await mount({ detected: true })
    // The local sign-in is a button in a row, not a section: nothing on the card
    // is titled after it.
    const headings = [...harness.container!.querySelectorAll<HTMLElement>('strong, h3, h4')]
      .map((element) => element.textContent ?? '')
    expect(headings.some((text) => text.includes('本机 Codex CLI'))).toBe(false)
    // The login row holds the two buttons and no prose between them.
    expect(loginRow().querySelectorAll('p')).toHaveLength(0)
    expect(loginRow().textContent).not.toContain('查找位置')
  })

  it('offers the button whether or not a sign-in was detected', async () => {
    // The decision this pins, and the one the source comment states: the button
    // does NOT disappear when the host found nothing. A control that vanishes
    // cannot answer whether one exists, and a click with nothing there still
    // returns the host's own sentence rather than silence.
    for (const detected of [true, false]) {
      globalThis.IS_REACT_ACT_ENVIRONMENT = true
      globalThis.fetch = vi.fn(async () => Response.json({
        ok: true, value: status({ codexCliSignInAvailable: detected }),
      })) as typeof fetch
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => root.render(createElement(CodexSubscriptionSection, { t } as never)))
      harness.container = container
      harness.teardown = async () => { await act(async () => root.unmount()); container.remove() }
      try {
        expect(importButton().textContent).toBe(zh.localCodexLoginImport)
        expect(importButton().disabled).toBe(false)
      } finally {
        await harness.teardown?.()
        delete harness.teardown
        delete harness.container
      }
    }
  })

  it('imports by naming its source, then re-reads the status', async () => {
    const calls = await mount({ detected: true })
    await act(async () => importButton().click())

    const adopt = calls.find((call) => call.url === ADOPT)
    expect(adopt?.method).toBe('POST')
    expect(adopt?.body).toEqual({ source: 'codex' })
    // Re-read rather than trusting the import's own answer: that answer is the
    // pool's status, which carries neither the new row nor the sign-in flag.
    expect(calls.map((call) => call.url)).toEqual([STATUS, ADOPT, STATUS])
    expect(harness.container!.querySelectorAll('.dsha-account-card')).toHaveLength(1)
  })

  it('surfaces a refusal in the existing error strip and leaves the button', async () => {
    await mount({ detected: false, adopt: 'No usable local Codex CLI sign-in was found (unrecognised local sign-in format).' })
    await act(async () => importButton().click())
    await act(async () => Promise.resolve())

    // The host's sentence, not a kinder one: it is the party that opened the file.
    expect(harness.container!.querySelector('[role="alert"]')?.textContent)
      .toContain('unrecognised local sign-in format')
    expect(harness.container!.querySelectorAll('.dsha-account-card')).toHaveLength(0)
  })
})
