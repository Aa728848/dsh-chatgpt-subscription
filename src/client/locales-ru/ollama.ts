/**
 * Russian wording for the Ollama namespace.
 *
 * Key set and order follow the `zh` object key for key; the meaning is taken
 * from `en`. Shared account-pool labels come from `account-pool.ts`; only the
 * keys this line overrides are repeated here.
 */
import type { OllamaLocaleKey } from '../ollama/locales.ts'
import { accountPoolRu } from './account-pool.ts'

export const dictionary: Record<OllamaLocaleKey, string> = {
  ...accountPoolRu,
  relogin: 'Заменить ключ',
  needsRelogin: 'Ключ отклонён',
  addAccount: 'Добавить API-ключ',
  noAccounts: 'API-ключей пока нет. Нажмите «Добавить API-ключ» и вставьте ключ с ollama.com.',

  title: 'Ollama',
  pageDesc: 'Подключите Ollama Cloud с несколькими API-ключами в пуле для ротации и переключения при сбоях.',
  routeOwned: 'Маршрут моделей обслуживает этот плагин',
  routeConflict: 'Маршрут моделей уже занят другим провайдером: {detail}',

  keySection: 'Добавить API-ключ',
  keyHint: 'Создайте ключ на https://ollama.com/settings/keys и вставьте его сюда. Ключи не истекают, отозвать их можно на той же странице.',
  keyPlaceholder: 'Вставьте API-ключ Ollama',
  keyAliasLabel: 'Метка (необязательно)',
  keyAliasPlaceholder: 'например, основной, резервный',
  keyAliasHint: 'Ollama не сообщает, какому аккаунту принадлежит ключ, поэтому ключи различают по метке.',
  keySave: 'Добавить',
  keySaving: 'Добавление…',

  modelsSection: 'Модели',
  modelsHint: 'Список приходит из Ollama «/api/tags» и следует за сервисом — вести его вручную не нужно.',
  catalogSync: 'Синхронизировать список моделей',
  catalogSyncing: 'Синхронизация…',
  catalogNeverSynced: 'Список моделей ещё не синхронизирован. Нажмите «Синхронизировать список моделей» выше, чтобы получить модели, доступные вашему аккаунту: до этого список пуст, и линия не появится в выборе моделей.',
  catalogEmpty: 'Ollama не вернула ни одной модели.',
  catalogNeedKey: 'Сначала добавьте API-ключ, потом синхронизируйте список моделей.',
  catalogFailed: 'Не удалось прочитать список моделей из Ollama.',
  modelCount: 'Моделей: {count}',
  noModels: 'Доступных моделей нет.',
  selectAll: 'Выбрать все',
  unselectAll: 'Снять все',
  noneSelected: 'Модели не выбраны, поэтому эта линия не появится в выборе моделей.',

  enhanced: 'Дополнительные возможности',
  defaultReasoningEffort: 'Уровень рассуждений по умолчанию',
  defaultReasoningEffortHint: 'Действует только на модели, которые принимают управление уровнем рассуждений. Допустимые уровни задаёт сама модель: семейство gpt-oss принимает low / medium / high, семейство deepseek-r1 — только включено или выключено, остальные управления не принимают, а Host сужает сохранённый уровень до допустимого для целевой модели. Выберите «Не задавать», чтобы каждая модель осталась на своём значении по умолчанию.',
  defaultEffortAuto: 'Не задавать',

  limitsSection: 'Документированные ограничения',
  limitsHint: 'Ollama Cloud документирует эти ограничения; линия их не обходит:',
  limitNoStateful: 'Нет Responses с сохранением состояния (только без состояния).',
  limitNoWebSearch: 'Нет встроенного поиска в вебе через /v1/responses.',
  limitNoToolReplay: 'Нет воспроизведения (replay) вызовов собственных инструментов.',
  limitUsage: 'У Ollama нет API квоты и остатка баланса (upstream-issue #15132 и #15663 закрыты), поэтому карточка показывает, сколько израсходовано, но не сколько осталось.',
  wireNote: 'Запросы идут через OpenAI-совместимую поверхность (/v1) и при необходимости откатываются на нативную (/api/chat).',

  lastModel: 'Последняя модель',
  keyCreated: 'Добавлен',
  error: 'Действие не выполнено: {detail}',
  usageTitle: 'Израсходовано всего',
  usageInput: 'вход {tokens}',
  usageOutput: 'выход {tokens}',
  usageRequests: 'Запросов: {count}',
  usageNone: 'Запросов ещё не было',
  usageHint: 'Суммируется локально по счётчикам токенов, которые Ollama возвращает в каждом ответе.',
}
