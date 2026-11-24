/**
 * Tracks whether the host's native `conversation.session.panel.section` slot is
 * mounted for this plugin. When active, the bottom `conversation.input.right`
 * composer capsules yield to the session panel card and skip their own polling.
 */
import { useSyncExternalStore } from 'react'

type Listener = () => void

let activeCount = 0
const listeners = new Set<Listener>()

function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // isolate subscriber errors
    }
  }
}

export function isSessionPanelQuotaActive(): boolean {
  return activeCount > 0
}

export function subscribeSessionPanelQuota(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Mark one session-panel slot registration active; returns its release callback. */
export function acquireSessionPanelQuota(): () => void {
  let released = false
  const wasActive = activeCount > 0
  activeCount += 1
  if (!wasActive) notify()
  return () => {
    if (released) return
    released = true
    activeCount = Math.max(0, activeCount - 1)
    if (activeCount === 0) notify()
  }
}

/** Test-only reset helper so a leaked registration cannot bleed across test files. */
export function resetSessionPanelQuotaForTest(): void {
  if (activeCount === 0) return
  activeCount = 0
  notify()
}

export function useSessionPanelQuotaActive(): boolean {
  return useSyncExternalStore(
    subscribeSessionPanelQuota,
    isSessionPanelQuotaActive,
    isSessionPanelQuotaActive,
  )
}
