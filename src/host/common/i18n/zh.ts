/**
 * Chinese copy for everything the Host says on its own.
 *
 * The key set here is the source of truth: `en` and `ru` are typed against
 * `keyof typeof zh`, so a key added here fails to compile until both other
 * languages carry it too. Values keep the exact wording the plugin shipped
 * before it spoke three languages — `zh` is the default locale, and a
 * regression in Chinese is a regression for every existing install.
 */
export const zh = {
  // Provider names as the model picker and the hub show them. These are the
  // values the plugin always registered; see '../i18n/provider-name.ts'.
  'provider.codex-chatgpt': 'Codex（ChatGPT 订阅）',
  'provider.claude': 'Claude（订阅）',
  'provider.workbuddy': 'WorkBuddy（CodeBuddy 订阅）',
  'provider.glm-coding-plan': 'GLM（ZCode 账号）',
  'provider.minimax-code': 'MiniMax Code（编程订阅）',
  'provider.qoder': 'Qoder（订阅）',
  'provider.step-code': 'Step Code（Step Plan 订阅）',

  // Account-pool messages. Each is an error the user sees in the conversation, so
  // the provider name travels as a parameter rather than being baked into the
  // sentence: the same pool serves every line.
  'pool.maxAccounts': '{provider} 号池最多支持 {max} 个账号，请先删除不再使用的账号。',
  'pool.notSignedIn': '未登录 {provider} 账号，请先在设置页添加账号。',
  'pool.allNeedSignIn': '全部 {count} 个 {provider} 账号均需要重新登录。',
  'pool.credentialRejected': '{provider} 账号的凭据已被拒绝，需要重新登录。',
  'pool.allUnavailable': '全部 {count} 个 {provider} 账号当前都不可用，且没有处于冷却中的账号。',
  'pool.allCoolingDown': '全部 {count} 个 {provider} 账号均处于配额限制或冷却中 (429)。最短预计在 {minutes} 分钟后解除冷却。',
} as const

/** Every Host copy key this plugin has. */
export type HostLocaleKey = keyof typeof zh
