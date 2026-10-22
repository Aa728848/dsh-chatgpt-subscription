/**
 * Russian wording of the labels every provider tab's account-pool card renders.
 *
 * Same role as `common/account-pool-labels.ts` on the `zh`/`en` side: one shared
 * set, so the twelve tabs cannot drift apart in wording, ordering or meaning.
 * Each Russian namespace spreads the subset it needs and may override keys that
 * would be untrue for its line (a pasted API key never expires, for instance).
 */
import type { AccountPoolLabels } from '../common/account-pool-labels.ts'

export const accountPoolRu: AccountPoolLabels = {
  accountPool: 'Аккаунты',
  addAccount: 'Добавить аккаунт',
  accountCount: 'Аккаунтов в системе: {count}',
  primaryAccount: 'Основной',
  activeAccount: 'Используется',
  setPrimary: 'Сделать основным',
  deleteAccount: 'Удалить',
  cooling: 'В паузе',
  cooldownLeft: 'осталось {minutes} мин',
  cooldownRemaining: 'осталось {minutes} мин {seconds} с',
  cooldownRemainingSeconds: 'осталось {seconds} с',
  clearCooldown: 'Сбросить паузу',
  needsRelogin: 'Нужен повторный вход',
  relogin: 'Войти заново',
  rotationStrategy: 'Порядок переключения',
  strategySequential: 'По очереди (основной первым, переключение при 429)',
  strategyRoundRobin: 'По кругу (равномерно между аккаунтами)',
  strategySticky: 'Закрепление (держать текущий аккаунт до лимита)',
  noAccounts: 'Аккаунтов пока нет. Нажмите «Добавить аккаунт», чтобы авторизоваться.',
  email: 'Почта',
  expires: 'Токен истекает',
  lastUsed: 'Последний вызов',
  accountId: 'ID аккаунта',
  accountQuota: 'Квота',
  quotaNone: 'Квота ещё не прочитана',
  quotaSnapshot: 'Снимок {time}',
  quotaResets: 'Сброс',
  quotaExhausted: 'Исчерпано',
  quotaWindow: 'Окно лимита',
  quotaUsed: 'использовано',
  quotaFactsScope: 'Это данные текущего аккаунта; прогресс каждого аккаунта виден на его карточке выше.',
  composerLabel: 'Квота',
}
