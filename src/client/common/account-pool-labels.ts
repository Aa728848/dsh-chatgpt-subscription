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
  storage: string
  storageNotice: string
  email: string
  expires: string
  lastUsed: string
  accountId: string
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
  storage: '凭据存储',
  storageNotice: '令牌由 Host 保存于本地安全存储，不会进入浏览器。',
  email: '邮箱',
  expires: '令牌到期',
  lastUsed: '上次调用',
  accountId: '账号 ID',
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
  storage: 'Credential storage',
  storageNotice: 'Credentials are stored locally by the Host and never sent to the browser.',
  email: 'Email',
  expires: 'Token expires',
  lastUsed: 'Last used',
  accountId: 'Account ID',
}

/** Replace `{name}` placeholders in one label. */
export function formatPoolLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (
    name in values ? String(values[name]) : match
  ))
}
