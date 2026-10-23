/**
 * Russian dictionary for the progress-updates namespace.
 *
 * Key set and order mirror the `zh` source; meaning follows `en`.
 */
import type { ProgressUpdatesLocaleKey } from '../progress-updates/locales.ts'

export const dictionary: Record<ProgressUpdatesLocaleKey, string> = {
  navTitle: 'Ход работы',
  progressTitle: 'Ход работы',
  progressGuideNote: 'Каждый шаг, о котором сообщает агент, собирается здесь',
  markdownCopy: 'Копировать',
  markdownCopied: 'Скопировано',
  markdownFootnotes: 'Сноски',
  progressLatest: 'Последний',
  progressCount: 'всего {n}',
  progressExpand: 'Развернуть эту запись',
  progressCollapse: 'Свернуть эту запись',
  progressEmptyTitle: 'Записей о ходе работы пока нет',
  progressEmptyHint: 'Когда агент начнёт многошаговую задачу, он будет сообщать здесь, на каком шаге находится.',
  rowPending: 'Ход работы',
  rowRunning: 'Сообщает',
  rowDone: 'Сообщено',
  rowError: 'Не отправлено',
  rowExpand: 'Развернуть подробности записи',
  rowCollapse: 'Свернуть подробности записи',
  settingsHint: 'Ход работы позволяет агенту сообщать о продвижении многошаговой задачи. Откройте панель, чтобы прочитать всё, что он сообщил.',
  settingsOpen: 'Открыть панель хода работы',
  settingsEnabledName: 'Ход работы',
  settingsEnabledNote: 'Разрешить агенту публиковать ход работы в диалоге',
  settingsThresholdName: 'Порог напоминания',
  settingsThresholdNote: 'Напомнить агенту после стольких раундов без отчёта',
  settingsLanguageName: 'Язык вывода',
  settingsLanguageNote: 'На каком языке пишутся заголовки и тексты записей',
  settingsLanguageAuto: 'Авто (как в диалоге)',
  settingsLanguageZh: 'Китайский',
  settingsLanguageEn: 'English',
  settingsPanelName: 'Панель хода работы',
  settingsPanelNote: 'Показывать все записи этой сессии в правой панели',
  settingsUnavailable: 'Эту настройку сейчас нельзя изменить (Host не предоставляет форму настроек)',
  settingsSaveFailed: 'Не удалось сохранить, попробуйте позже',
}
