import type { CompactAfterTurnLocaleKey } from '../features/compact-after-turn/locales.ts'

export const dictionary: Record<CompactAfterTurnLocaleKey, string> = {
  label: 'Сжать после этого хода',
  infoLabel: 'О сжатии после этого хода',
  hint: 'Когда включено, контекст сжимается один раз сразу после окончания этого хода, затем переключатель выключается сам. Ход, остановленный вручную, не считается: переключатель остаётся включённым до конца следующего хода.',
  stateArmed: 'Ожидает',
  stateCompacting: 'Сжатие…',
  unavailable: 'В этой DSH нет доступного механизма сжатия.',
  lastCompacted: 'В прошлый раз: сжато.',
  lastNothing: 'В прошлый раз: сжимать было нечего.',
  lastFailed: 'Последнее сжатие не удалось: {detail}',
  errorBusy: 'Идёт сжатие; переключатель станет доступен после его завершения.',
  errorFailed: 'Не удалось изменить переключатель: {message}',
}
