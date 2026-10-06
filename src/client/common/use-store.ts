/**
 * Subscribe to a snapshot store as a React value.
 *
 * Two copies of this existed — the shared composer badge and the ChatGPT badge —
 * which is why it lives in its own module rather than being exported from the
 * badge: a component module exporting a generic hook reads as if the hook
 * belonged to that component.
 */
import { useSyncExternalStore } from 'react'
import type { SnapshotStore } from '../store.ts'

export function useStore<T>(store: SnapshotStore<T>): T {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  )
}
