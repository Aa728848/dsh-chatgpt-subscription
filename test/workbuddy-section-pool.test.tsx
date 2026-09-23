// @vitest-environment jsdom
/**
 * The WorkBuddy tab renders the shared account card, like its four siblings.
 *
 * WorkBuddy was the fifth line to adopt the pool and the only one whose settings
 * card still hand-rolled its account list: the account management and identity
 * panels were in the opposite order, the heading and button styles differed, and
 * the models carried a capability line no sibling rendered. These assertions pin
 * the unified shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkBuddySection } from '../src/client/workbuddy/WorkBuddySection.tsx'
import { accountPoolZh as poolZh } from '../src/client/common/account-pool-labels.ts'
import { zh } from '../src/client/workbuddy/locales.ts'

const ACCOUNTS = [
  {
    id: 'cn:u1',
    alias: '主力账号',
    isPrimary: true,
    uin: '100000000001',
    region: 'cn',
    source: 'managed',
    removable: true,
    hidden: false,
    domain: 'copilot.tencent.com',
    backend: 'https://copilot.tencent.com',
    accountType: 'personal',
    lastUsedAt: Date.now() - 60_000,
    expiresAt: Date.now() + 3_600_000,
  },
  {
    id: 'cn:u2',
    alias: '备用账号',
    isPrimary: false,
    uin: '100000000002',
    region: 'cn',
    source: 'desktop',
    sourceFile: '/home/me/auth/workbuddy-desktop.info',
    removable: false,
    hidden: false,
  },
]

const CHECKIN = {
  enabled: true,
  totalAccounts: 2,
  doneToday: 1,
  skippedToday: 0,
  failedToday: 0,
  lastRunAt: Date.parse('2026-03-01T09:30:00'),
}

function statusPayload(overrides: Record<string, unknown> = {}) {
  return {
    authenticated: true,
    hasCredentials: true,
    authDirectory: '/home/me/auth',
    storagePath: '/home/me/models.json',
    managedStoragePath: '/home/me/accounts.json.dpapi',
    account: ACCOUNTS[0],
    quota: null,
    lastFetchedAt: null,
    models: [
      {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        description: 'a very long marketing description',
        enabled: true,
        defaultContextWindow: 128_000,
        contextWindow: 1_000_000,
        defaultMaxTokens: 32_768,
        supportsImage: true,
        reasoningEfforts: ['low', 'high', 'max'],
        regions: ['cn'],
      },
    ],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    selectedAccountId: 'cn:u1',
    accounts: ACCOUNTS,
    activeAccountId: 'cn:u1',
    rotationStrategy: 'sequential',
    enabled: true,
    serving: true,
    conflict: null,
    ...overrides,
  }
}

let originalFetch: typeof globalThis.fetch
let originalActEnvironment: boolean | undefined
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function render(overrides: Record<string, unknown> = {}): Promise<void> {
  globalThis.fetch = vi.fn(async () => Response.json({ ok: true, value: statusPayload(overrides) })) as typeof fetch
  await act(async () => root.render(createElement(WorkBuddySection, {})))
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  globalThis.fetch = originalFetch
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  vi.restoreAllMocks()
})

describe('WorkBuddy settings card', () => {
  it('renders the pooled accounts through the shared card', async () => {
    await render()

    // Two accounts reach the shared card, each with the shared badges.
    expect(container.querySelectorAll('.dsha-account-card')).toHaveLength(2)
    expect(container.querySelector('.dsha-account-title')?.textContent).toBe('主力账号')
    const first = container.querySelectorAll('.dsha-account-card')[0]!
    expect(first.querySelector('.dsha-badge.primary')?.textContent).toBe(poolZh.primaryAccount)
    expect(first.querySelector('.dsha-badge.active')?.textContent).toBe(poolZh.activeAccount)
    // The shared group heading, strategy picker and labels are the shared ones;
    // only the storage notice is overridden, as every sibling tab overrides it.
    expect(container.textContent).toContain('账号管理')
    expect(container.textContent).toContain(poolZh.rotationStrategy)
    expect(container.textContent).toContain(poolZh.storage)
    expect(container.textContent).toContain(zh.storageNotice)
    // WorkBuddy-specific identity facts still reach the card via renderDetails,
    // including the full token expiry the shared card does not render itself.
    expect(container.textContent).toContain('1000****01')
    expect(container.textContent).toContain('copilot.tencent.com')
    expect(container.textContent).toContain(zh.accountType)
  })

  it('uses the sibling group order, with no separate identity panel', async () => {
    await render()

    const headings = [...container.querySelectorAll('.dsha-group')]
      .map((group) => group.querySelector('.dsha-grouphead h3')?.textContent ?? '')
    // Identical to the other four tabs: the account card carries identity too,
    // so there is no standalone 账号 group between it and 连接.
    expect(headings[0]).toContain('账号管理')
    expect(headings[1]).toBe(zh.connection)
    expect(headings).not.toContain(zh.account)
    expect(headings.filter((heading) => heading.includes('账号管理'))).toHaveLength(1)
    // The provider switch, its verification and the rescan entry live in the
    // card; the connection group keeps the shared route notice.
    expect(container.textContent).toContain(zh.enableProvider)
    expect(container.textContent).toContain(zh.rescan)
    expect(container.textContent).toContain(zh.routeOwned)
  })

  it('offers both regional login entry points with the primary button style', async () => {
    await render()

    const login = [...container.querySelectorAll<HTMLButtonElement>('.dsha-account-add-actions button')]
    expect(login.map((button) => button.textContent)).toEqual([zh.addCnAccount, zh.addIntlAccount])
    // The tab used the plain .dsha-btn while its siblings used the primary one.
    for (const button of login) expect(button.classList.contains('dsha-btn-primary')).toBe(true)
  })

  it('shows only the model name on a pill, not the capability summary', async () => {
    await render()

    const pill = container.querySelector('.dsha-models label')!
    expect(pill.querySelector('span')?.textContent).toBe('GLM-5.3')
    // The context window / image / effort facts moved into the tooltip, so this
    // tab renders the same single-line pill as its four siblings.
    expect(pill.textContent).not.toContain('1M')
    expect(pill.textContent).not.toContain(zh.imageSupport)
    expect(pill.getAttribute('title')).toContain('1M')
    expect(pill.getAttribute('title')).toContain(zh.imageSupport)
    expect(pill.getAttribute('title')).toContain('low/high/max')
  })

  it('shows the empty state through the shared card, not a panel of its own', async () => {
    // The shared card already renders "no account signed in"; a second
    // not-found panel beside it is exactly the drift this tab had.
    await render({ authenticated: false, accounts: [], activeAccountId: undefined })
    expect(container.querySelectorAll('.dsha-account-card')).toHaveLength(0)
    // Exactly one "no accounts" panel: the shared card's, rendered once.
    const accountGroup = container.querySelector('.dsha-group')!
    expect(accountGroup.querySelectorAll('.dsha-empty')).toHaveLength(1)
    expect(accountGroup.textContent).toContain(zh.noAccounts)
    // Its login entry points stay reachable while signed out.
    expect(accountGroup.textContent).toContain(zh.addCnAccount)
  })

  it('renders the daily check-in summary, including accounts with no activity', async () => {
    await render({
      checkin: {
        enabled: true,
        totalAccounts: 3,
        doneToday: 1,
        skippedToday: 1,
        failedToday: 1,
        lastRunAt: Date.parse('2026-03-01T09:30:00'),
      },
    })

    const groups = [...container.querySelectorAll('.dsha-group')]
    const checkin = groups.find((group) => group.querySelector('h3')?.textContent === zh.dailyCheckin)!
    expect(checkin).toBeDefined()
    // The signed-in count must not absorb the account whose activity is simply
    // inactive, which is what the card used to report as a sign-in.
    expect(checkin.textContent).toContain(zh.checkinToday.replace('{done}', '1').replace('{total}', '3'))
    expect(checkin.textContent).toContain(zh.checkinSkipped.replace('{count}', '1'))
    expect(checkin.textContent).toContain(zh.checkinFailed.replace('{count}', '1'))
    expect(checkin.textContent).not.toContain(zh.checkinNever)
  })

  it('omits the check-in row for a host that predates the scheduler', async () => {
    await render({ checkin: null })
    const headings = [...container.querySelectorAll('.dsha-grouphead h3')].map((node) => node.textContent)
    expect(headings).not.toContain(zh.dailyCheckin)
  })

  it('persists the check-in toggle through the settings route', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return Response.json({ ok: true, value: statusPayload({ checkin: CHECKIN }) })
    }) as typeof fetch
    await act(async () => root.render(createElement(WorkBuddySection, {})))

    const toggle = [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
      .find((input) => input.closest('.dsha-row')?.textContent?.includes(zh.checkinAuto))!
    expect(toggle.checked).toBe(true)
    // A real click: React's input value tracking suppresses onChange when the
    // checked property is assigned directly before dispatching the event.
    await act(async () => { toggle.click() })

    const patch = calls.find((call) => call.url === '/workbuddy/api/settings')
    expect(patch?.body).toEqual({ checkin: { enabled: false } })
  })

  it('runs a manual check-in through the same-origin route', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: unknown) => {
      urls.push(String(url))
      return Response.json({ ok: true, value: statusPayload({ checkin: CHECKIN }) })
    }) as typeof fetch
    await act(async () => root.render(createElement(WorkBuddySection, {})))

    const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent === zh.checkinNow)!
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(urls).toContain('/workbuddy/api/checkin/now')
  })

  it('promotes another account through the provider accounts route', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      if (String(url) === '/workbuddy/api/accounts/action') {
        return Response.json({
          ok: true,
          value: statusPayload({
            accounts: [{ ...ACCOUNTS[0]!, isPrimary: false }, { ...ACCOUNTS[1]!, isPrimary: true }],
          }),
        })
      }
      return Response.json({ ok: true, value: statusPayload() })
    }) as typeof fetch

    await act(async () => root.render(createElement(WorkBuddySection, {})))
    const promote = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === poolZh.setPrimary)
    expect(promote).toBeDefined()
    await act(async () => promote!.click())

    expect(calls[1]).toEqual({
      url: '/workbuddy/api/accounts/action',
      body: { action: 'set-primary', accountId: 'cn:u2' },
    })
  })
})
