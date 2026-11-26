/** 进展面板的数据源适配；视觉实现见 dashboard.tsx。 */
import { useSyncExternalStore, type ReactNode } from 'react'
import { ProgressDashboard } from './dashboard.tsx'
import type { ProgressTask, ProgressUpdate } from './contracts.ts'
import { NS_PROGRESS_UPDATES, zh, type ProgressUpdatesLocaleKey } from './locales.ts'

export type CopySeat = {
  t?: (key: ProgressUpdatesLocaleKey) => string
}

export function fallbackTranslate(key: string, params?: Record<string, unknown>): string {
  return interpolate((zh as Record<string, string>)[key] ?? key, params)
}

export function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  let text = template
  for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

export interface ProgressSnapshotSource {
  getSnapshot(): readonly ProgressUpdate[]
  /** 可选只读任务快照；旧数据源省略时按空列表。 */
  getTasksSnapshot?(): readonly ProgressTask[]
  subscribe(listener: () => void): () => void
}

export const EMPTY_UPDATES: readonly ProgressUpdate[] = Object.freeze([])
export const EMPTY_TASKS: readonly ProgressTask[] = Object.freeze([])
const emptyTasks = (): readonly ProgressTask[] => EMPTY_TASKS

export const EMPTY_SOURCE: ProgressSnapshotSource = Object.freeze({
  getSnapshot: () => EMPTY_UPDATES,
  getTasksSnapshot: emptyTasks,
  subscribe: () => () => {},
})

export function createSnapshotSource(
  read: () => readonly ProgressUpdate[],
  listen: (listener: () => void) => () => void,
): ProgressSnapshotSource {
  return { getSnapshot: read, subscribe: listen }
}

export type UpdatesPanelProps = {
  updates: readonly ProgressUpdate[]
  tasks?: readonly ProgressTask[]
} & CopySeat

export function ProgressUpdatesPanel({ updates, tasks = EMPTY_TASKS, t }: UpdatesPanelProps): ReactNode {
  return <ProgressDashboard updates={updates} tasks={tasks} t={t} />
}

export interface ProgressPanelInjected {
  source: ProgressSnapshotSource
}

export function ProgressUpdatesTab(props: ProgressPanelInjected & CopySeat): ReactNode {
  const { source, t } = props
  const updates = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const readTasks = source.getTasksSnapshot ?? emptyTasks
  const tasks = useSyncExternalStore(source.subscribe, readTasks, readTasks)
  return <ProgressDashboard updates={updates} tasks={tasks} t={t} />
}

export function ProgressUpdatesTabTitle({ t }: CopySeat): ReactNode {
  const label = t === undefined ? fallbackTranslate('progressTitle') : t('progressTitle')
  return <>{label}</>
}

export { NS_PROGRESS_UPDATES }