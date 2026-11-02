/**
 * Russian copy for everything the Host says on its own.
 *
 * Terminology follows the client language pack in
 * 'src/client/locales-ru/': "подписка" for a subscription line and the
 * product's own name left untranslated.
 */
import type { HostLocaleKey } from './zh.ts'

export const ru: Record<HostLocaleKey, string> = {
  'provider.codex-chatgpt': 'Codex (подписка ChatGPT)',
  'provider.claude': 'Claude (подписка)',
  'provider.workbuddy': 'WorkBuddy (подписка CodeBuddy)',
  'provider.glm-coding-plan': 'GLM (аккаунт ZCode)',
  'provider.minimax-code': 'MiniMax Code (подписка для кода)',
  'provider.qoder': 'Qoder (подписка)',
  'provider.step-code': 'Step Code (подписка Step Plan)',

  'pool.maxAccounts': 'Пул аккаунтов {provider} вмещает не больше {max}; сначала удалите неиспользуемый аккаунт.',
  'pool.notSignedIn': 'Вход в аккаунт {provider} не выполнен; сначала добавьте его на странице настроек.',
  'pool.allNeedSignIn': 'Всем аккаунтам {provider} ({count}) нужно войти заново.',
  'pool.credentialRejected': 'Учётные данные аккаунта {provider} отклонены; войдите заново.',
  'pool.allUnavailable': 'Все аккаунты {provider} ({count}) сейчас недоступны, и ни один не в режиме ожидания.',
  'pool.allCoolingDown': 'Все аккаунты {provider} ({count}) ограничены по квоте или в режиме ожидания (429). Ближайший освободится примерно через {minutes} мин.',
}
