/**
 * Labels every provider tab's account-pool card renders.
 *
 * They live here rather than in each provider's locale file so the four tabs
 * cannot drift apart in wording, ordering or meaning. The active locale is the
 * one the host already selects per provider; each `locales.ts` spreads the set
 * it needs and may override individual keys.
 */

/** Labels the shared card needs, in the order its markup uses them. */
export interface AccountPoolLabels {
  accountPool: string
  addAccount: string
  /** `{count}` is replaced with the number of signed-in accounts. */
  accountCount: string
  primaryAccount: string
  activeAccount: string
  setPrimary: string
  deleteAccount: string
  cooling: string
  /** `{minutes}` is replaced with the remaining cooldown in whole minutes. */
  cooldownLeft: string
  clearCooldown: string
  needsRelogin: string
  relogin: string
  rotationStrategy: string
  strategySequential: string
  strategyRoundRobin: string
  strategySticky: string
  noAccounts: string
  email: string
  expires: string
  lastUsed: string
  accountId: string
  /** Legend of the per-account quota block. */
  accountQuota: string
  /** Shown when no quota was ever read for that account. */
  quotaNone: string
  /** `{time}` is replaced with the snapshot's read time. */
  quotaSnapshot: string
  /** Prefix of a window's reset moment, e.g. `重置 3 小时后`. */
  quotaResets: string
  /** Drawn in place of a percentage once a window is spent. */
  quotaExhausted: string
  /** Fallback window name when the line gave neither a label nor a length. */
  quotaWindow: string
  /** Read out by a screen reader beside the bar's percentage. */
  quotaUsed: string
  /** Explains that the page-level facts belong to the current account only. */
  quotaFactsScope: string
  /** The composer badge's own label, in front of its number. */
  composerLabel: string
}

/** Chinese labels; the wording the Antigravity card shipped with. */
export const accountPoolZh: AccountPoolLabels = {
  accountPool: '账号管理',
  addAccount: '添加账号',
  accountCount: '已登录 {count} 个账号',
  primaryAccount: '主账号',
  activeAccount: '当前使用',
  setPrimary: '设为主账号',
  deleteAccount: '删除',
  cooling: '冷却中',
  cooldownLeft: '剩 {minutes} 分',
  clearCooldown: '重置冷却',
  needsRelogin: '需重新登录',
  relogin: '重新登录',
  rotationStrategy: '调度策略',
  strategySequential: '顺序耗尽（当前优先，遇限流自动切号）',
  strategyRoundRobin: '轮询调度（按账号循环均匀分摊）',
  strategySticky: '粘性会话（保持当前账号，遇限流才切换）',
  noAccounts: '暂无账号，点击「添加账号」完成登录授权。',
  email: '邮箱',
  expires: '令牌到期',
  lastUsed: '上次调用',
  accountId: '账号 ID',
  accountQuota: '配额',
  quotaNone: '尚无配额数据',
  quotaSnapshot: '快照 {time}',
  quotaResets: '重置',
  quotaExhausted: '已用尽',
  quotaWindow: '额度窗口',
  quotaUsed: '已用',
  quotaFactsScope: '以下为当前账号的配额事实；每个账号自己的进度显示在它的账号卡片里。',
  composerLabel: '额度',
}

/** English labels for the ChatGPT tab, which is the bilingual one. */
export const accountPoolEn: AccountPoolLabels = {
  accountPool: 'Account Management',
  addAccount: 'Add Account',
  accountCount: '{count} account(s) signed in',
  primaryAccount: 'Primary',
  activeAccount: 'In Use',
  setPrimary: 'Set as Primary',
  deleteAccount: 'Delete',
  cooling: 'In Cooldown',
  cooldownLeft: '{minutes} min left',
  clearCooldown: 'Clear Cooldown',
  needsRelogin: 'Sign-in required',
  relogin: 'Sign in again',
  rotationStrategy: 'Scheduling Strategy',
  strategySequential: 'Sequential Drain (primary first, fail over on 429)',
  strategyRoundRobin: 'Round-Robin (evenly rotate across accounts)',
  strategySticky: 'Sticky Session (keep the current account until it is limited)',
  noAccounts: 'No accounts yet. Click "Add Account" to authorize.',
  email: 'Email',
  expires: 'Token expires',
  lastUsed: 'Last used',
  accountId: 'Account ID',
  accountQuota: 'Quota',
  quotaNone: 'No quota read yet',
  quotaSnapshot: 'Snapshot {time}',
  quotaResets: 'Resets',
  quotaExhausted: 'Exhausted',
  quotaWindow: 'Limit window',
  quotaUsed: 'used',
  quotaFactsScope: 'These facts describe the current account; each account\u2019s own progress is shown on its card above.',
  composerLabel: 'Quota',
}

/** Replace `{name}` placeholders in one label. */
export function formatPoolLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (
    name in values ? String(values[name]) : match
  ))
}
