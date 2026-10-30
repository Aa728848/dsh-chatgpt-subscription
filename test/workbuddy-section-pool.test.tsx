// @vitest-environment jsdom
/**
 * The WorkBuddy tab renders the shared account card, like its four siblings —
 * plus the three facts only this gateway produces, drawn by the card itself.
 *
 * WorkBuddy was the fifth line to adopt the pool and the only one whose settings
 * card still hand-rolled its account list: the account management and identity
 * panels were in the opposite order, the heading and button styles differed, and
 * the models carried a capability line no sibling rendered. These assertions pin
 * the unified shape.
 *
 * The second half pins the line-private state. A whole-pool pause, an
 * account-scoped restriction and a single parked model are three different
 * answers to "can this account serve my request?", and the shared pool card
 * cannot tell them apart — so this card states them, and states the pause first.
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
    // The shared group heading and strategy picker are the shared ones.
    expect(container.textContent).toContain('账号管理')
    expect(container.textContent).toContain(poolZh.rotationStrategy)
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
    // One group renders WITHOUT an h3: the outbound-identity and at-rest-key
    // block is a sub-block of the card rather than a panel, so it contributes no
    // heading and must not appear in this order.
    expect(headings).not.toContain(zh.outboundSection)
    const named = headings.filter((heading) => heading !== '')
    // Identical to the other four tabs: the account card carries identity too,
    // so there is no standalone 账号 group between it and 连接.
    expect(named[0]).toContain('账号管理')
    expect(named[1]).toBe(zh.connection)
    expect(headings).not.toContain(zh.account)
    expect(headings.filter((heading) => heading.includes('账号管理'))).toHaveLength(1)
    // The provider switch lives on the overview card now; the connection group
    // keeps the rescan entry and the shared route notice.
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

  it('shows the model name with its capability facts on the quiet hint line', async () => {
    await render()

    // The shared checklist row: name on the first line, and the context window /
    // image / effort facts on the hint line, in the claude-style picker's idiom.
    const row = container.querySelector('.dsh-mcl-option')!
    expect(row.querySelector('.dsh-mcl-name')?.textContent).toBe('GLM-5.3')
    const hint = row.querySelector('.dsh-mcl-hint')?.textContent ?? ''
    expect(hint).toContain('1M')
    expect(hint).toContain(zh.imageSupport)
    expect(hint).toContain('low/high/max')
    expect(row.getAttribute('title')).toBe('glm-5.3')
  })

  it('states the account region\u2019s consumption rate at the end of the hint line', async () => {
    await render({
      models: [
        {
          id: 'glm-5.3', name: 'GLM-5.3', enabled: true, defaultContextWindow: 128_000,
          contextWindow: 1_000_000, defaultMaxTokens: 32_768, supportsImage: true,
          reasoningEfforts: ['low', 'high', 'max'], regions: ['cn'],
          credits: { cn: '0.79', intl: '0.79' },
        },
        {
          id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', enabled: true,
          defaultContextWindow: 128_000, contextWindow: 128_000, defaultMaxTokens: 32_768,
          supportsImage: false, regions: ['cn'], credits: { cn: '0.11', intl: '0.00' },
        },
      ],
    })

    const hints = [...container.querySelectorAll<HTMLElement>('.dsh-mcl-option')].map((row) => [
      row.querySelector('.dsh-mcl-name')?.textContent ?? '',
      row.querySelector('.dsh-mcl-hint')?.textContent ?? '',
    ])
    // The account is cn, so each row states cn's own rate and nothing else.
    // Measured 2026-10-09: deepseek-v4.1-flash is 0.11 on cn against 0.00 on
    // intl, and quoting the sibling number here would state a price this
    // account never pays. The rate trails the capability facts, which are what
    // the model accepts; the multiplier is what it costs.
    expect(hints).toEqual([
      ['GLM-5.3', '1M · 图片 · low/high/max · 倍率 0.79x'],
      ['DeepSeek V4.1 Flash', '128K · 纯文本 · 倍率 0.11x'],
    ])
  })

  it('omits the rate without leaving a separator behind', async () => {
    // The default catalog row declares no credits, which is the shipped shape
    // for a model the gateway did not rate.
    await render()

    const hint = container.querySelector('.dsh-mcl-hint')?.textContent ?? ''
    expect(hint).toBe('1M · 图片 · low/high/max')
    expect(hint).not.toContain(zh.creditMultiplier)
    // No placeholder and no doubled separator: the row did not grow a slot it
    // could not fill.
    expect(hint).not.toMatch(/·\s*·/)
    expect(hint.split(' · ')).not.toContain('')
  })

  it('names both regions in the row when the account region is unknown', async () => {
    // No account read back yet, so the row cannot know which backend will bill
    // it. The two published rates are stated instead of one being picked:
    // measured 2026-10-09 these two anchors disagree on cn (0.11) and intl (0.00).
    await render({
      account: null,
      models: [
        {
          id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', enabled: true,
          defaultContextWindow: 300_000, contextWindow: 300_000, defaultMaxTokens: 128_000,
          supportsImage: true, reasoningEfforts: ['low', 'high', 'max'], regions: ['intl', 'cn'],
          credits: { cn: '0.11', intl: '0.00' },
        },
        {
          id: 'glm-5.3', name: 'GLM-5.3', enabled: true,
          defaultContextWindow: 1_000_000, contextWindow: 1_000_000, defaultMaxTokens: 48_000,
          supportsImage: true, reasoningEfforts: ['low', 'high', 'max'], regions: ['intl', 'cn'],
          credits: { cn: '0.79', intl: '0.79' },
        },
      ],
    })

    const hints = [...container.querySelectorAll<HTMLElement>('.dsh-mcl-option')].map(
      (row) => row.querySelector('.dsh-mcl-hint')?.textContent ?? '',
    )
    // cn is named first and both entries carry their qualifier; the equal pair
    // collapses to the single value, because there is nothing to disambiguate.
    expect(hints[0]).toBe('300K · 图片 · low/high/max · 倍率 0.11x（国区） / 0.00x（国际区）')
    expect(hints[1]).toBe('1M · 图片 · low/high/max · 倍率 0.79x')
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

  it('keeps the settings card mounted while editing reserve credits', async () => {
    await render({ guardrails: { reserveCredits: 0, dailyTokens: 0, modelDailyTokens: 0 } })
    const field = [...container.querySelectorAll<HTMLElement>('.dsh-wb-field')]
      .find((candidate) => candidate.textContent?.includes(zh.guardrailsReserve))!
    const input = field.querySelector<HTMLInputElement>('input')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!

    await act(async () => {
      for (const draft of ['1', '12']) {
        setValue.call(input, draft)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })

    expect(input.value).toBe('12')
    expect(container.textContent).toContain(zh.guardrailsSection)
  })
})

/** The whole-pool banner, which is a div rather than a settings group. */
function poolBanner(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.dsh-wb-pool')
}

describe('WorkBuddy whole-pool state', () => {
  it('states a pause before the account list and stops every row reading as usable', async () => {
    const accountsList = '.dsha-accounts-list'
    await render({
      pool: { paused: true, pauseReason: 'every account restricted upstream', pausedUntil: Date.now() + 5 * 60_000 },
    })

    const banner = poolBanner()
    expect(banner).not.toBeNull()
    expect(banner!.textContent).toContain(zh.poolPaused)
    expect(banner!.textContent).toContain(zh.poolPausedReason.replace('{reason}', 'every account restricted upstream'))
    // A pause that lifts on its own states when, in the reader's own words.
    expect(banner!.textContent).toContain('后自动恢复')

    // The banner precedes the account list in document order: a green card above
    // this sentence would read as availability whatever the sentence says.
    const list = container.querySelector(accountsList)!
    expect(banner!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Every row carries the marker, so no account can be read as routable.
    expect(container.querySelectorAll('.dsha-account-card')).toHaveLength(2)
    expect(container.querySelectorAll('.dsh-wb-flag')).toHaveLength(2)
    for (const flag of container.querySelectorAll('.dsh-wb-flag')) {
      expect(flag.textContent).toBe(zh.notRoutable)
    }
    // Nothing on the card claims the pool is available while it is paused.
    expect(container.textContent).not.toContain('可用账号')
  })

  it('says a pause does not lift on its own when no horizon is reported', async () => {
    await render({ pool: { paused: true } })

    const banner = poolBanner()!
    expect(banner.textContent).toContain(zh.poolPausedManual)
    expect(banner.textContent).not.toContain('后自动恢复')
    // No reason reported means no "Reason:" line with an empty tail.
    expect(banner.textContent).not.toContain(zh.poolPausedReason.replace('{reason}', '').trim())
  })

  it('marks only the accounts the pool lists as restricted', async () => {
    await render({ pool: { paused: false, restrictedAccountIds: ['cn:u2'] } })

    const banner = poolBanner()!
    expect(banner.textContent).toContain(zh.poolRestrictedCount.replace('{count}', '1'))
    // An unpaused pool with one barred account is neither "paused" nor healthy
    // for that account: the flag lands on the barred row only.
    const cards = [...container.querySelectorAll<HTMLElement>('.dsha-account-card')]
    expect(cards[0]!.querySelector('.dsh-wb-flag')).toBeNull()
    expect(cards[1]!.querySelector('.dsh-wb-flag')?.textContent).toBe(zh.notRoutable)
  })

  it('draws the account-scoped refusal with its code, horizon and message', async () => {
    await render({
      accounts: [
        { ...ACCOUNTS[0]!, restriction: { code: 11140, message: 'account barred', until: Date.now() + 3 * 60_000 } },
        ACCOUNTS[1],
      ],
      pool: { paused: false, restrictedAccountIds: ['cn:u1'] },
    })

    const card = container.querySelector<HTMLElement>('.dsha-account-card')!
    const flags = [...card.querySelectorAll('.dsh-wb-flag')].map((node) => node.textContent ?? '')
    expect(flags[0]).toBe(zh.notRoutable)
    // The gateway's own code and words travel with it: "restricted" alone does
    // not tell a user whether to wait or to sign in again.
    expect(flags.some((line) => line.includes('11140'))).toBe(true)
    expect(flags.some((line) => line === zh.restrictedAccountMessage.replace('{message}', 'account barred'))).toBe(true)
    expect(flags.some((line) => line.endsWith('后解除'))).toBe(true)
  })

  it('names the parked model and drops a park that already lifted', async () => {
    const live = Date.now() + 2 * 60_000
    await render({
      accounts: [
        {
          ...ACCOUNTS[0]!,
          modelCooldowns: [
            { model: 'glm-5.3', cooldownUntil: live },
            { model: 'hunyuan-t1', cooldownUntil: Date.now() - 60_000 },
          ],
        },
        ACCOUNTS[1],
      ],
    })

    const parks = [...container.querySelectorAll('.dsh-wb-park')]
    expect(parks).toHaveLength(1)
    expect(parks[0]!.textContent).toContain('glm-5.3')
    expect(parks[0]!.textContent).toContain('后解除')
    // A lift-time in the past is not a park: listing it would tell the user an
    // eligible model is unavailable.
    expect(container.textContent).not.toContain('hunyuan-t1')
    // The row keeps its quota block beside the park.
    expect(container.querySelectorAll('.dsha-account-quota')).toHaveLength(2)
  })

  it('describes the pool store with the shared storage semantics, not a private path', async () => {
    await render({ pool: { paused: false, storage: { mode: 'keyring', backend: 'dpapi', encrypted: true } } })

    const banner = poolBanner()!
    expect(banner.textContent).toContain(zh.poolStorageLabel)
    expect(banner.textContent).toContain(zh.poolStorageBackendDpapi)
    expect(banner.textContent).toContain(zh.poolStorageEncrypted)
    // The configured value is not what a user got: `keyring` resolves to DPAPI
    // here, so the raw mode token never reaches the page.
    expect(banner.textContent).not.toContain('keyring')
    // Nor does a credential path: where the store lives is not a setting.
    expect(banner.textContent).not.toContain('/home/me')
  })

  it('states why the configured store is unusable here', async () => {
    await render({
      pool: {
        paused: false,
        storage: { mode: 'credentials', backend: 'credentials', encrypted: false, unavailable: 'no-credentials-service' },
      },
    })

    const banner = poolBanner()!
    expect(banner.textContent).toContain(zh.poolStoragePlain)
    expect(banner.textContent).toContain(zh.poolStorageUnavailableCredentials)
  })

  it('renders no pool block at all for a host that predates pool persistence', async () => {
    // Absent is not "not paused": a card that invented "running" from a missing
    // field would claim a pool state the host never reported.
    await render()
    expect(poolBanner()).toBeNull()
    expect(container.querySelectorAll('.dsh-wb-flag')).toHaveLength(0)
  })
})
