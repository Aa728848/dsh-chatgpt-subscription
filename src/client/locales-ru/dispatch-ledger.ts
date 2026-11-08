/**
 * Russian dictionary for the dispatch-ledger namespace.
 *
 * Key set and order mirror the `zh` source; meaning follows `en`.
 */
import type { DispatchLedgerLocaleKey } from '../dispatch-ledger/locales.ts'

export const dictionary: Record<DispatchLedgerLocaleKey, string> = {
  mandateTitle: 'Запуск субагента',
  mandateTitleFork: 'Запуск субагента (с контекстом)',
  mandatePreparing: 'Сборка задания',
  mandateRunning: 'Субагент запускается',
  mandateDone: 'Запущен',
  mandateFailed: 'Запуск отклонён',
  mandateExpand: 'Развернуть запись о запуске',
  mandateCollapse: 'Свернуть запись о запуске',
  mandateBrief: 'Задача',
  mandateRun: 'Запуск',
  mandateIdem: 'Ключ идемпотентности',
  mandateRoute: 'Маршрут',
  mandateTask: 'Ссылки на задачу',
  mandateBoundary: 'Границы',
  mandateFollowup: 'Последующий контекст',
  mandateBody: 'Текст задачи',
  mandateResult: 'Результат',
  mandateRawShow: 'Исходные аргументы',
  mandateRawHide: 'Скрыть исходные аргументы',
  mandateNoHeader: 'У этого вызова нет заголовка мандата (только аудит, без дедупликации)',
  mandateNoBody: '(нет текста)',
}
