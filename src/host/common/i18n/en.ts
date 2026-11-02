/**
 * English copy for everything the Host says on its own.
 *
 * Typed against the Chinese key set, so a key that exists there and not here is
 * a compile error rather than a raw key name in the interface.
 */
import type { HostLocaleKey } from './zh.ts'

export const en: Record<HostLocaleKey, string> = {
  'provider.codex-chatgpt': 'ChatGPT Subscription',
  'provider.claude': 'Claude Subscription',
  'provider.workbuddy': 'WorkBuddy (CodeBuddy Subscription)',
  'provider.glm-coding-plan': 'GLM (ZCode Account)',
  'provider.minimax-code': 'MiniMax Code (Coding Subscription)',
  'provider.qoder': 'Qoder Subscription',
  'provider.step-code': 'Step Code (Step Plan Subscription)',

  'pool.maxAccounts': 'The {provider} account pool holds at most {max} accounts; delete one that is no longer used first.',
  'pool.notSignedIn': 'No {provider} account is signed in; add one on the settings page first.',
  'pool.allNeedSignIn': 'All {count} {provider} accounts have to sign in again.',
  'pool.credentialRejected': 'The credential of the {provider} account was rejected; sign in again.',
  'pool.allUnavailable': 'All {count} {provider} accounts are unavailable right now, and none is cooling down.',
  'pool.allCoolingDown': 'All {count} {provider} accounts are rate limited or cooling down (429). The earliest clears in about {minutes} minutes.',
}
