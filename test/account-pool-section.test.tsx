// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AccountPoolSection,
  cooldownMinutesLeft,
  formatAccountDate,
  isCoolingDown,
  type AccountPoolSectionProps,
} from '../src/client/common/AccountPoolSection.tsx'
import { accountPoolEn, accountPoolZh, formatPoolLabel } from '../src/client/common/account-pool-labels.ts'
import type { PoolAccountSummaryDto } from '../src/shared/account-pool-contracts.ts'

const now = Date.now()

function account(overrides: Partial<PoolAccountSummaryDto> = {}): PoolAccountSummaryDto {
  return {
    id: 'acc_1',
    alias: '主账号',
    isPrimary: true,
    email: 'first@example.com',
    ...overrides,
  }
}

function render(overrides: Partial<AccountPoolSectionProps> = {}): string {
  const props: AccountPoolSectionProps = {
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
  return renderToStaticMarkup(<AccountPoolSection {...props} />)
}

describe('AccountPoolSection', () => {
  it('renders the empty state and the storage notice when no account is signed in', () => {
    const html = render({ accounts: [] })
    expect(html).toContain('账号管理')
    expect(html).toContain(accountPoolZh.noAccounts)
    expect(html).toContain(accountPoolZh.storageNotice)
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

  it('marks a cooling account and offers to clear the cooldown', () => {
    const html = render({
      accounts: [account({ cooldownUntil: now + 10 * 60_000, cooldownReason: '429 Rate Limit' })],
    })
    expect(html).toContain('dsha-badge cooldown')
    expect(html).toContain('冷却中')
    expect(html).toContain('剩 10 分')
    expect(html).toContain(accountPoolZh.clearCooldown)
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
    expect(cooldownMinutesLeft(now + 61_000, now)).toBe(2)
    expect(cooldownMinutesLeft(now + 60_000, now)).toBe(1)
    expect(cooldownMinutesLeft(now - 1000, now)).toBe(1)
    expect(isCoolingDown({ ...account(), cooldownUntil: now + 1000 }, now)).toBe(true)
    expect(isCoolingDown({ ...account(), cooldownUntil: now - 1000 }, now)).toBe(false)
    expect(isCoolingDown(account(), now)).toBe(false)
  })

  it('keeps every locale set complete so no tab can render an empty label', () => {
    const keys = Object.keys(accountPoolZh).sort()
    expect(Object.keys(accountPoolEn).sort()).toEqual(keys)
    for (const value of Object.values(accountPoolZh)) expect(value.length).toBeGreaterThan(0)
    for (const value of Object.values(accountPoolEn)) expect(value.length).toBeGreaterThan(0)
  })
})
