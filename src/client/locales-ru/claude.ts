/**
 * Russian dictionary for the Claude subscription tab.
 *
 * Key set and order mirror the `zh` source; meaning follows `en`. The shared
 * account-pool labels come from `./account-pool.ts`, with the same overrides the
 * source applies on top of them.
 */
import { accountPoolRu } from './account-pool.ts'
import type { ClaudeLocaleKey } from '../claude/locales.ts'

export const dictionary: Record<ClaudeLocaleKey, string> = {
  // The account-management card is shared with every other provider tab.
  ...accountPoolRu,
  title: 'Claude (подписка)',
  pageDesc: 'Войдите в подписку Claude Pro/Max и управляйте моделями, уровнями рассуждений, контекстными окнами и квотой.',

  // --- Account card ---
  account: 'Аккаунт',
  signedIn: 'Вход выполнен',
  signedOut: 'Вход не выполнен',
  email: 'Почта',
  plan: 'Тариф',
  planUnknown: '—',
  subscriptionType: 'Тип подписки',
  source: 'Источник',
  sourceManaged: 'Вход в этом плагине',
  sourceClaudeCode: 'Локальный Claude Code',
  adoptedBadge: 'Импортированный снимок',

  // --- Sign-in flow ---
  signIn: 'Войти в Claude',
  signInSection: 'Вход',
  signInAgain: 'Войти заново',
  signingIn: 'Запускаем вход…',
  cancelSignIn: 'Отменить вход',
  openAuthorizeUrl: 'Открыть страницу авторизации',
  authorizeUrl: 'Ссылка авторизации',
  redirectUri: 'Адрес возврата',
  loginModeManual: 'Ручной режим: браузерного возврата нет, поэтому вставьте код со страницы после авторизации в поле ниже.',
  loginModeLoopback: 'Режим локального возврата: после авторизации браузер сам вернётся на локальный адрес.',
  loginFallbackReason: 'Локальный возврат недоступен, включён ручной режим: {detail}',
  loginWaiting: 'Ждём завершения авторизации в браузере…',
  loginExchanging: 'Обмениваем токен…',
  loginComplete: 'Вход выполнен',
  loginFailed: 'Вход не удался',
  manualPasteSection: 'Вставить код авторизации',
  manualPasteHint: 'Вставьте код из адресной строки браузера (или весь URL возврата), чтобы завершить вход. В ручном режиме браузерного возврата нет — это единственный путь.',
  manualPastePlaceholder: 'code#state или полный URL возврата',
  manualPasteSubmit: 'Отправить код',
  manualPasteSubmitting: 'Отправляем…',

  // --- Adoption of the local Claude Code sign-in ---
  importClaudeCode: 'Импортировать вход локального Claude Code',
  importing: 'Импорт…',
  stopImporting: 'Остановить импорт',

  // --- Connection ---
  connection: 'Соединение',
  testConnection: 'Проверить соединение',
  testingConnection: 'Проверяем…',
  testSuccess: 'Соединение в порядке',
  testLatency: 'отклик {ms} мс',
  testFailed: 'Соединение не удалось: {detail}',
  testRetryable: 'можно повторить',
  testNotRetryable: 'повтор невозможен',
  routeOwned: 'Маршрут моделей обслуживает этот плагин',
  routeConflict: 'Маршрут моделей уже занят другим провайдером: {detail}. Удалите дублирующего провайдера в настройках DSH и повторите.',

  // --- Models ---
  modelsSection: 'Модели',
  modelsHint: 'Модель попадает в список выбора модели на странице диалога, только если она отмечена.',
  refreshCatalog: 'Обновить каталог моделей',
  refreshingCatalog: 'Обновляем…',
  selectAll: 'Выбрать все',
  unselectAll: 'Снять все',
  capImage: 'Изображения',
  capNoImage: 'Только текст',
  capThinkingOff: 'Рассуждения можно отключить',
  thinkingModeMidConvo: 'Рассуждения в середине диалога',
  thinkingModeAdaptive: 'Адаптивные рассуждения',
  thinkingModeBudget: 'Рассуждения с бюджетом',
  thinkingModeNone: 'Без рассуждений',

  // --- Thinking ---
  enhanced: 'Рассуждения',
  defaultReasoningEffort: 'Уровень рассуждений по умолчанию',
  defaultReasoningEffortHint: 'В списке все уровни, которые встречаются в каталоге (включая xhigh); какие уровни принимает каждая модель, видно ниже — Host отправляет тот, что поддерживает сама модель.',
  defaultEffortAuto: 'Значение модели по умолчанию',
  cacheTtl: 'Время жизни кеша промпта',
  cacheTtlHint: 'Anthropic предлагает две ступени: 5 минут и 1 час. Пока подписка расходует лимит тарифа, официальный Claude Code держит час для основного диалога; после исчерпания тарифа и перехода на оплату по расходу он возвращается к пяти минутам. Запись на час дороже, для коротких сессий она не окупается.',
  cacheTtlSubscription: 'Как у официального (в подписке по умолчанию 1 ч)',
  cacheTtl1h: '1 час',
  cacheTtl5m: '5 минут',
  effortLow: 'Низкий (low)',
  effortMedium: 'Средний (medium)',
  effortHigh: 'Высокий (high)',
  effortXHigh: 'Очень высокий (xhigh)',
  effortMax: 'Максимальный (max)',
  modelLadders: 'Уровни по моделям',
  modelLadderNone: 'Эта модель не принимает уровень рассуждений',

  // --- Context windows ---
  contextWindowSection: 'Контекстное окно модели',
  contextWindowHint: 'По умолчанию берётся длина контекста из каталога, сохранённое переопределение важнее. Сброс к умолчанию удаляет переопределение, и Host снова берёт значение каталога.',
  contextWindowReset: 'Сбросить к умолчанию',
  contextWindowResetAll: 'Сбросить все',
  contextWindowResetAllConfirm: 'Сбросить контекстные окна всех изменённых моделей к значениям по умолчанию?',
  contextWindowNoneEnabled: 'Ни одна модель не отмечена. Отметьте модель выше, и здесь появятся её настройки контекстного окна.',
  contextWindowInvalid: 'Недопустимый размер контекста: {value}',
  save: 'Сохранить',
  saving: 'Сохраняем…',
  tokens: 'токены',

  // --- Quota ---
  quotaSection: 'Расход и квота',
  quotaDesc: 'Данные из эндпоинта расхода Claude и заголовков ответа; на видимой странице обновляются не чаще раза в 60 секунд. utilization — это процент использования, поэтому 0% — нормальное пустое состояние.',
  refreshQuota: 'Обновить расход',
  refreshingQuota: 'Обновляем…',
  quotaRefreshing: 'Host обновляет квоту в фоне, цифры скоро появятся.',
  quotaEmpty: 'Данных о квоте пока нет — нажмите «Обновить расход», чтобы повторить.',
  quotaSignedOut: 'Вход не выполнен, расход прочитать нельзя.',
  quotaUnknown: '—',
  quotaUnknownHint: 'Host не назвал число для этого окна, поэтому здесь пусто, а не ноль.',
  usedLabel: 'Использовано',
  remainingLabel: 'Осталось',
  left: 'доступно',
  resetAt: 'Сброс: {time}',
  resetUnknown: 'время сброса неизвестно',
  updatedAt: 'Обновлено: {time}',
  observedAt: 'Последнее наблюдение: {time}',
  quotaError: 'Не удалось прочитать квоту',
  extraUsage: 'Дополнительный расход',
  extraUsageEnabled: 'включён',
  extraUsageDisabled: 'выключен',
  extraUsageLimit: 'Месячный лимит',
  sourceUsage: 'Источник: эндпоинт расхода',
  sourceHeaders: 'Источник: заголовки ответа',
  quotaStatus: 'Статус ограничений',
  quotaRepresentative: 'Показательное окно',

  loading: 'Загрузка…',
  now: 'сейчас',
  copy: 'Копировать',
  copied: 'Скопировано',
}
