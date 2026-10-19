// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AccountPoolSection,
  formatAccountDate,
  formatCooldownRemaining,
  isCoolingDown,
  type AccountPoolSectionProps,
} from '../src/client/common/AccountPoolSection.tsx'
import { accountPoolEn, accountPoolZh, formatPoolLabel } from '../src/client/common/account-pool-labels.ts'
import type { PoolAccountSummaryDto } from '../src/shared/account-pool-contracts.ts'

const now = Date.now()

/** React's act() only drives updates when the environment says so. */
let originalActEnvironment: boolean | undefined

/**
 * The clock is pinned for every test.
 *
 * A cooldown that counts seconds is only exact against a fixed clock: left to
 * the wall clock, the text a test asserts on depends on how long the test
 * itself took, and "剩 1 分 30 秒" can be "剩 1 分 29 秒" by the time the next
 * line runs.
 */
beforeEach(() => {
  originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
})

afterEach(() => {
  vi.useRealTimers()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
})

function account(overrides: Partial<PoolAccountSummaryDto> = {}): PoolAccountSummaryDto {
  return {
    id: 'acc_1',
    alias: '主账号',
    isPrimary: true,
    email: 'first@example.com',
    ...overrides,
  }
}

function propsFor(overrides: Partial<AccountPoolSectionProps> = {}): AccountPoolSectionProps {
  return {
    accounts: [account()],
    activeAccountId: 'acc_1',
    rotationStrategy: 'sequential',
    labels: accountPoolZh,
    busy: null,
    onLogin: vi.fn(),
    onSetPrimary: vi.fn(),
    onDelete: vi.fn(),
    onClearCooldown: vi.fn(),
    onSetStrategy: vi.fn(),
    ...overrides,
  }
}

/** The card as the server renders it: effects do not run, so no timer ticks. */
function render(overrides: Partial<AccountPoolSectionProps> = {}): string {
  return renderToStaticMarkup(<AccountPoolSection {...propsFor(overrides)} />)
}

/** The card as the browser runs it: mounted, so its effects do run. */
async function mount(overrides: Partial<AccountPoolSectionProps> = {}): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<AccountPoolSection {...propsFor(overrides)} />)
  })
  return container
}

describe('AccountPoolSection', () => {
  it('renders the empty state when no account is signed in', () => {
    const html = render({ accounts: [] })
    expect(html).toContain('账号管理')
    expect(html).toContain(accountPoolZh.noAccounts)
    expect(html).not.toContain('dsha-account-card')
  })

  it('shows the primary and in-use badges plus the shared identity details', () => {
    const html = render({
      accounts: [account({ lastUsedAt: now, expiresAt: now + 3600_000 })],
    })
    expect(html).toContain('dsha-badge primary')
    expect(html).toContain('dsha-badge active')
    expect(html).toContain('主账号')
    expect(html).toContain('当前使用')
    expect(html).toContain('first@example.com')
    expect(html).toContain(accountPoolZh.expires)
    expect(html).toContain(accountPoolZh.lastUsed)
  })

  it('names the address once, even when the alias is that address', () => {
    // Most lines sign in with an address and alias the account with it, so the
    // card's title already IS the address; printing "邮箱: <same>" under it is
    // the same fact twice.
    const titled = render({ accounts: [account({ alias: 'me@example.com', email: 'me@example.com' })] })
    expect(titled.match(/me@example\.com/g)).toHaveLength(1)
    // A nickname alias still gets the address beside it.
    const nicknamed = render({ accounts: [account({ alias: '主力账号', email: 'me@example.com' })] })
    expect(nicknamed).toContain('me@example.com')
    expect(nicknamed).toContain(accountPoolZh.email)
  })

  it('marks a cooling account and offers to clear the cooldown', () => {
    const html = render({
      accounts: [account({ cooldownUntil: now + 10 * 60_000, cooldownReason: '429 Rate Limit' })],
    })
    expect(html).toContain('dsha-badge cooldown')
    expect(html).toContain('冷却中')
    expect(html).toContain('剩 10 分')
    expect(html).toContain(accountPoolZh.clearCooldown)
  })

  it('counts the cooldown down to the second and drops the badge when it lifts', async () => {
    // The card's own clock drives the badge: the number moves every second on
    // its own, and the badge disappears when the cooldown is over - no refetch.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(now)
    const container = await mount({
      accounts: [account({ cooldownUntil: now + 90_000 })],
    })
    const badge = () => container.querySelector('.dsha-badge.cooldown')?.textContent ?? ''

    expect(badge()).toBe('冷却中（剩 1 分 30 秒）')
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(badge()).toBe('冷却中（剩 1 分 29 秒）')
    // Exactly a minute left: the seconds are dropped instead of shown as zero.
    await act(async () => { vi.advanceTimersByTime(29_000) })
    expect(badge()).toBe('冷却中（剩 1 分）')
    // Under a minute: the seconds alone, because "剩 1 分" here would be a lie.
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(badge()).toBe('冷却中（剩 30 秒）')
    // The cooldown is over, so the badge goes away by itself.
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(badge()).toBe('')
  })

  it('draws each parked model its own row, and none when nothing is parked', () => {
    const html = render({
      accounts: [account({
        modelCooldowns: [
          { model: 'glm-5.3', cooldownUntil: now + 4 * 60_000 + 32_000 },
          { model: 'kimi-k3', cooldownUntil: now + 42_000 },
        ],
      })],
    })
    // One row per parked model, each with its own remaining time: a model park
    // is not the account's own cooldown, and the account keeps serving the
    // models that are not parked.
    expect(html.match(/dsha-account-model-cooldown-row/g)).toHaveLength(2)
    expect(html).toContain('glm-5.3')
    expect(html).toContain('kimi-k3')
    expect(html).toContain('剩 4 分 32 秒')
    expect(html).toContain('剩 42 秒')
    expect(html).toContain(accountPoolZh.modelCooldown)

    // An account that parks nothing grows no row at all.
    const plain = render({ accounts: [account()] })
    expect(plain).not.toContain('dsha-account-model-cooldown-row')
    expect(plain).not.toContain(accountPoolZh.modelCooldown)

    // A park that has already lifted is not drawn either.
    const lifted = render({
      accounts: [account({ modelCooldowns: [{ model: 'glm-5.3', cooldownUntil: now - 1_000 }] })],
    })
    expect(lifted).not.toContain('glm-5.3')
  })

  it('flags an account that needs another sign-in and only offers relogin when handled', () => {
    const withoutHandler = render({
      accounts: [account({ authStatus: 'expired', authFailedReason: 'Refresh token rejected' })],
    })
    expect(withoutHandler).toContain('dsha-badge danger')
    expect(withoutHandler).toContain('需重新登录')
    expect(withoutHandler).toContain('Refresh token rejected')
    expect(withoutHandler).not.toContain('设为主账号')

    const withHandler = render({
      accounts: [account({ authStatus: 'expired' })],
      onRelogin: vi.fn(),
    })
    expect(withHandler).toContain(accountPoolZh.relogin)
  })

  it('offers the rotation strategy only with more than one account, including sticky', () => {
    const single = render()
    expect(single).not.toContain('调度策略')

    const multiple = render({
      accounts: [
        account({ id: 'acc_1', isPrimary: false, authStatus: undefined }),
        account({ id: 'acc_2', alias: '备用', email: 'second@example.com', isPrimary: false }),
      ],
      activeAccountId: 'acc_2',
      rotationStrategy: 'sticky',
    })
    expect(multiple).toContain('调度策略')
    expect(multiple).toContain(accountPoolZh.strategySticky)
    expect(multiple).toContain('value="sticky" selected=""')
    expect(multiple).toContain('selected=""')
  })

  it('renders provider-specific detail rows before the shared ones', () => {
    const html = render({
      accounts: [account()],
      renderDetails: (entry) => <span key="project">账号 ID: proj-{entry.id}</span>,
      children: <p className="dsha-muted">额外控件</p>,
    })
    expect(html).toContain('账号 ID: proj-acc_1')
    expect(html.indexOf('proj-acc_1')).toBeLessThan(html.indexOf('first@example.com'))
    expect(html).toContain('额外控件')
  })

  it('disables every control while an action is in flight', () => {
    const html = render({ busy: 'login' })
    expect(html).toContain('disabled=""')
  })
  it('never offers Delete for an account the plugin does not own', () => {
    // WorkBuddy adopts the CodeBuddy desktop client's own accounts. Deleting
    // one would strand the IDE's session, so the card must not offer it and the
    // provider supplies its own action instead.
    const foreign = render({ accounts: [account({ removable: false })] })
    expect(foreign).not.toContain(accountPoolZh.deleteAccount)

    const owned = render({ accounts: [account()] })
    expect(owned).toContain(accountPoolZh.deleteAccount)
  })

  it('renders provider-supplied account actions and login entry points', () => {
    const html = render({
      accounts: [account({ removable: false })],
      renderAccountActions: () => <button className="dsha-btn">隐藏</button>,
      renderLoginActions: () => <button className="dsha-btn dsha-btn-primary">添加国区账号</button>,
    })
    expect(html).toContain('隐藏')
    expect(html).toContain('添加国区账号')
    // A provider that renders its own entry points replaces the generic one.
    expect(html).not.toContain(accountPoolZh.addAccount)
  })

  it('formats labels, dates and cooldown minutes the same way in both locales', () => {
    expect(formatPoolLabel(accountPoolZh.accountCount, { count: 3 })).toBe('已登录 3 个账号')
    expect(formatPoolLabel(accountPoolEn.accountCount, { count: 1 })).toBe('1 account(s) signed in')
    expect(formatPoolLabel('no placeholder', { count: 1 })).toBe('no placeholder')
    expect(formatAccountDate(undefined)).toBe('—')
    expect(formatAccountDate(now)).toContain('20')
    expect(formatCooldownRemaining(4 * 60_000 + 32_000, accountPoolZh)).toBe('剩 4 分 32 秒')
    expect(formatCooldownRemaining(42_000, accountPoolZh)).toBe('剩 42 秒')
    expect(formatCooldownRemaining(5 * 60_000, accountPoolZh)).toBe('剩 5 分')
    expect(formatCooldownRemaining(4 * 60_000 + 32_000, accountPoolEn)).toBe('4 min 32s left')
    expect(formatCooldownRemaining(42_000, accountPoolEn)).toBe('42s left')
    expect(isCoolingDown({ ...account(), cooldownUntil: now + 1000 }, now)).toBe(true)
    expect(isCoolingDown({ ...account(), cooldownUntil: now - 1000 }, now)).toBe(false)
    expect(isCoolingDown(account(), now)).toBe(false)
  })

  it('draws each account its own quota, because quota follows the account', () => {
    const html = render({
      showQuota: true,
      accounts: [
        account({ id: 'acc_1', quota: { fetchedAt: now, windows: [{ label: '', usedPercent: 40, windowDurationMins: 300, resetsAt: null }] } }),
        account({ id: 'acc_2', isPrimary: false, alias: '备用', quota: { fetchedAt: now, windows: [{ label: 'Weekly', usedPercent: 90, windowDurationMins: 10_080, resetsAt: null }] } }),
      ],
    })
    // Two accounts, two independent readings — not one line-level figure drawn
    // twice.
    expect(html.match(/dsha-account-quota-row/g)).toHaveLength(2)
    expect(html).toContain('40%')
    expect(html).toContain('Weekly')
    expect(html).toContain('aria-valuenow="90"')
  })

  it('says an account has no quota reading yet, but only on a line that reads quota', () => {
    const reading = account({ quota: { fetchedAt: now, windows: [{ label: '', usedPercent: 5, windowDurationMins: 300, resetsAt: null }] } })
    const never = account({ id: 'acc_2', isPrimary: false, alias: '备用' })

    // One sibling with a snapshot proves the line reads quota per account, so
    // the account it has not read yet may say so.
    const mixed = render({ accounts: [reading, never] })
    expect(mixed).toContain(accountPoolZh.quotaNone)

    // A line with no quota concept at all (Ollama: spend, no allowance) must
    // not grow a "not read yet" row on every account.
    expect(render({ accounts: [never] })).not.toContain(accountPoolZh.quotaNone)
    expect(render({ accounts: [never], showQuota: true })).toContain(accountPoolZh.quotaNone)
  })

  it('keeps every locale set complete so no tab can render an empty label', () => {
    const keys = Object.keys(accountPoolZh).sort()
    expect(Object.keys(accountPoolEn).sort()).toEqual(keys)
    for (const value of Object.values(accountPoolZh)) expect(value.length).toBeGreaterThan(0)
    for (const value of Object.values(accountPoolEn)) expect(value.length).toBeGreaterThan(0)
  })
})
