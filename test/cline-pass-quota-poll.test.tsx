// @vitest-environment jsdom
/**
 * The Cline Pass card and badge keep their own numbers current.
 *
 * Both surfaces read the same status route, and both used to read it exactly
 * once — at mount — so a quota window that moved while the tab stayed open was
 * never redrawn. These are the regressions this file locks down: the 60 s poll
 * only ticks while the tab is visible, an answer that reports a background
 * refresh is followed up shortly instead of waiting for the next tick, a failed
 * poll stays silent, and a click on the badge is the forced read rather than
 * another cheap GET.
 *
 * Only the tab-visibility knobs and the timer are faked; `Date` is left alone so
 * a fixture that stamps `fetchedAt` keeps meaning what it says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ClinePassSection } from '../src/client/cline-pass/ClinePassSection.tsx'
import { ClinePassComposerQuota } from '../src/client/cline-pass/ClinePassComposerQuota.tsx'
import { ClinePassApi, quotaRefreshingOf } from '../src/client/cline-pass/api.ts'
import type { ClinePassWebStatus } from '../src/shared/cline-pass-contracts.ts'

/** The status shape with the optional field the host is adding, read by tests. */
type StatusWithRefresh = ClinePassWebStatus & { quotaRefreshing?: boolean }

const BASE: StatusWithRefresh = {
  enabled: true,
  providerId: 'cline-pass',
  baseURL: 'https://api.cline.bot/api/v1',
  serving: true,
  conflict: null,
  exposeTools: false,
  usable: true,
  authenticated: true,
  pool: {
    accounts: [{ id: 'a1', alias: '主号', isPrimary: true, authKind: 'oauth' }],
    activeAccountId: 'a1',
    rotationStrategy: 'round-robin',
  },
  models: [],
  catalogSynced: true,
  catalogCount: 0,
  usage: {
    accounts: [{
      accountId: 'a1',
      alias: '主号',
      ok: true,
      windows: [{ type: 'five_hour', label: '5 小时', percentUsed: 42, resetsAt: '' }],
      error: '',
      fetchedAt: 1,
    }],
    fetchedAt: 1,
  },
  historySize: 0,
  login: null,
  settings: {
    baseURL: 'https://api.cline.bot/api/v1',
    defaultContextWindow: 128_000,
    defaultMaxTokens: 64_000,
    maxConcurrentRequests: 16,
    streamIdleTimeoutMs: 300_000,
    historyLimit: 100,
    exposeCatalog: false,
    pinSpelling: 'both',
  },
}

function status(overrides: Partial<StatusWithRefresh> = {}): ClinePassWebStatus {
  return { ...BASE, ...overrides }
}

interface WireCall {
  method: string
  url: string
}

let calls: WireCall[] = []
let answer: () => StatusWithRefresh = () => BASE
let failure: Error | null = null

/** Answer every route the way the host does, and record what was asked. */
function installFetch(): void {
  calls = []
  failure = null
  answer = () => BASE
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ method: init?.method ?? 'GET', url })
    if (failure !== null) throw failure
    const value = answer()
    // The forced read answers `{ usage, status }`; the plain one answers the
    // status alone. A client that reads the wrong half fails here.
    if (url.endsWith('/usage')) {
      return Response.json({ ok: true, value: { usage: value.usage, status: value } })
    }
    return Response.json({ ok: true, value })
  }))
}

const statusReads = (): WireCall[] => calls.filter((call) => call.url.endsWith('/status'))

let container: HTMLDivElement | null = null
let root: Root | null = null

/** jsdom fixes `visibilityState` on the prototype; shadow it for one test. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  installFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
  delete (document as unknown as { visibilityState?: unknown }).visibilityState
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mountSection(): Promise<HTMLDivElement> {
  root = createRoot(container as HTMLDivElement)
  await act(async () => {
    root!.render(<ClinePassSection />)
  })
  return container as HTMLDivElement
}

/** Let a fake timer fire and the resulting promise chain settle. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

describe('the Cline Pass card', () => {
  it('reads once on mount, then again on the 60 s tick while the tab is visible', async () => {
    setVisibility('visible')
    await mountSection()
    expect(statusReads()).toHaveLength(1)

    await tick(59_999)
    expect(statusReads()).toHaveLength(1)

    await tick(1)
    expect(statusReads()).toHaveLength(2)
    // Every tick is the cheap read: only a click or the button forces a refresh.
    expect(statusReads().every((call) => call.method === 'GET')).toBe(true)
  })

  it('does not read while the tab is hidden', async () => {
    setVisibility('hidden')
    await mountSection()
    expect(statusReads()).toHaveLength(1)

    await tick(60_000)
    await tick(60_000)
    expect(statusReads()).toHaveLength(1)
  })

  it('reads once when a hidden tab becomes visible again', async () => {
    setVisibility('hidden')
    await mountSection()
    expect(statusReads()).toHaveLength(1)

    setVisibility('visible')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(statusReads()).toHaveLength(2)

    // Going the other way is not a reason to read anything.
    setVisibility('hidden')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(statusReads()).toHaveLength(2)
  })

  it('follows up shortly after an answer that reported a refresh in flight', async () => {
    setVisibility('visible')
    answer = () => status({ quotaRefreshing: true })
    await mountSection()
    expect(statusReads()).toHaveLength(1)

    // The follow-up is a short one, not the 60 s tick.
    await tick(1_499)
    expect(statusReads()).toHaveLength(1)

    await tick(1)
    expect(statusReads()).toHaveLength(2)
  })

  it('does not follow up when the answer reported nothing in flight', async () => {
    setVisibility('visible')
    await mountSection()
    expect(statusReads()).toHaveLength(1)
    await tick(10_000)
    expect(statusReads()).toHaveLength(1)
  })

  it('stays silent when a background poll fails', async () => {
    setVisibility('visible')
    await mountSection()
    expect((container as HTMLDivElement).textContent).toContain('主号')

    failure = new Error('the host fell over')
    await tick(60_000)
    expect(statusReads()).toHaveLength(2)
    // No red sentence, and the card the user was reading is still there.
    expect((container as HTMLDivElement).textContent).not.toContain('the host fell over')
    expect((container as HTMLDivElement).textContent).toContain('主号')
  })

  it('clears the interval and the listener when it unmounts', async () => {
    setVisibility('visible')
    await mountSection()
    expect(statusReads()).toHaveLength(1)
    await act(async () => {
      root!.unmount()
    })
    root = null
    await tick(120_000)
    expect(statusReads()).toHaveLength(1)
  })
})

describe('the Cline Pass composer badge', () => {
  /** The badge only renders for the provider the conversation is on. */
  function directory(): unknown {
    const state = { current: { provider: 'cline-pass', model: 'cline-pass/glm-5.3' }, models: [] }
    return { subscribe: () => () => undefined, getSnapshot: () => state }
  }

  it('reads cheaply on mount and asks for the forced read on a click', async () => {
    setVisibility('visible')
    root = createRoot(container as HTMLDivElement)
    await act(async () => {
      root!.render(<ClinePassComposerQuota directory={directory() as never} loadModelDirectory={() => undefined} />)
    })

    const badge = (container as HTMLDivElement).querySelector('.dsha-composer-quota')
    expect(badge).not.toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'GET' })
    expect(calls[0]?.url.endsWith('/status')).toBe(true)
    expect((container as HTMLDivElement).querySelector('.dsha-composer-quota-val')?.textContent).toBe('58%')

    await act(async () => {
      badge?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // The click is the same POST the card's own button drives — the argument the
    // line dropped before, which made the badge a second cheap GET.
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ method: 'POST' })
    expect(calls[1]?.url.endsWith('/usage')).toBe(true)
  })
})

describe('ClinePassApi.status', () => {
  it('is a GET by default and the POST /usage when a refresh is asked for', async () => {
    const api = new ClinePassApi()
    await expect(api.status()).resolves.toMatchObject({ providerId: 'cline-pass' })
    expect(calls[0]).toMatchObject({ method: 'GET' })
    expect(calls[0]?.url.endsWith('/cline-pass/api/status')).toBe(true)

    const forced = await api.status(true)
    expect(calls[1]).toMatchObject({ method: 'POST' })
    expect(calls[1]?.url.endsWith('/cline-pass/api/usage')).toBe(true)
    // The forced answer carries `{ usage, status }`; the caller gets the status.
    expect(forced.providerId).toBe('cline-pass')
    expect(forced.settings).toEqual(BASE.settings)
  })

  it('treats an absent refresh flag as nothing in flight', () => {
    expect(quotaRefreshingOf(status())).toBe(false)
    expect(quotaRefreshingOf(status({ quotaRefreshing: true }))).toBe(true)
    expect(quotaRefreshingOf(status({ quotaRefreshing: false }))).toBe(false)
  })
})
