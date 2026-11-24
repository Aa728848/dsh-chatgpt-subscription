/**
 * Shared per-provider polling cache for the session quota panel section and its
 * folded-header summary reading, so both surfaces stay in sync without issuing
 * duplicate status requests.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SnapshotStore } from '../../providers/codex-chatgpt/store.ts'
import { useStore } from '../../common/use-store.ts'
import { SESSION_QUOTA_ADAPTERS, type SessionQuotaAdapter } from './adapters.ts'
import type { SessionQuotaDict, SessionQuotaSnapshot } from './model.ts'

interface EntryView {
  readonly raw: unknown
  readonly hasData: boolean
  readonly loading: boolean
}

interface ProviderEntry {
  view: EntryView
  subscribers: Set<() => void>
  timer: number | null
  inFlight: Promise<void> | null
}

const POLL_INTERVAL_MS = 60_000
const EMPTY_SNAPSHOT_STATE: EntryView = { raw: null, hasData: false, loading: false }
const entries = new Map<string, ProviderEntry>()

function getOrCreateEntry(providerId: string): ProviderEntry {
  let entry = entries.get(providerId)
  if (entry === undefined) {
    entry = {
      view: EMPTY_SNAPSHOT_STATE,
      subscribers: new Set(),
      timer: null,
      inFlight: null,
    }
    entries.set(providerId, entry)
  }
  return entry
}

function setView(entry: ProviderEntry, next: EntryView): void {
  entry.view = next
  for (const listener of entry.subscribers) {
    try {
      listener()
    } catch {
      // isolate subscriber errors
    }
  }
}

async function fetchProvider(adapter: SessionQuotaAdapter, entry: ProviderEntry, refresh: boolean): Promise<void> {
  if (entry.inFlight !== null && !refresh) return entry.inFlight
  setView(entry, { ...entry.view, loading: true })
  const run = (async () => {
    try {
      const next = await adapter.readStatus(refresh)
      setView(entry, { raw: next, hasData: true, loading: false })
    } catch {
      // keep previous snapshot on transient failure
      setView(entry, { ...entry.view, loading: false })
    } finally {
      entry.inFlight = null
    }
  })()
  entry.inFlight = run
  return run
}

function subscribeProvider(adapter: SessionQuotaAdapter, listener: () => void): () => void {
  const entry = getOrCreateEntry(adapter.providerId)
  const wasIdle = entry.subscribers.size === 0
  entry.subscribers.add(listener)
  if (wasIdle) {
    void fetchProvider(adapter, entry, false)
    entry.timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchProvider(adapter, entry, false)
      }
    }, POLL_INTERVAL_MS)
  }
  return () => {
    entry.subscribers.delete(listener)
    if (entry.subscribers.size === 0 && entry.timer !== null) {
      window.clearInterval(entry.timer)
      entry.timer = null
    }
  }
}

export interface SessionQuotaState {
  snapshot: SessionQuotaSnapshot | null
  loading: boolean
  refresh: () => void
}

export function useSessionQuota(
  directory: SnapshotStore<ModelDirectoryState>,
  loadModelDirectory: () => void,
  dict: SessionQuotaDict,
  adapters: ReadonlyMap<string, SessionQuotaAdapter> = SESSION_QUOTA_ADAPTERS,
): SessionQuotaState {
  const modelState = useStore(directory)
  const selected = modelState.current
  const adapter = selected?.provider ? adapters.get(selected.provider) : undefined

  useEffect(() => {
    loadModelDirectory()
  }, [loadModelDirectory])

  const subscribe = useCallback(
    (onStoreChange: () => void) => (adapter ? subscribeProvider(adapter, onStoreChange) : () => {}),
    [adapter],
  )
  const getSnapshot = useCallback(
    () => {
      if (!adapter) return EMPTY_SNAPSHOT_STATE
      const entry = entries.get(adapter.providerId)
      return entry ? entry.view : EMPTY_SNAPSHOT_STATE
    },
    [adapter],
  )

  const entrySnapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_SNAPSHOT_STATE,
  )

  const snapshot = useMemo(() => {
    if (!adapter || !entrySnapshot.hasData || entrySnapshot.raw === null) return null
    return adapter.toSnapshot(entrySnapshot.raw, selected?.model, dict)
  }, [adapter, dict, entrySnapshot.hasData, entrySnapshot.raw, selected?.model])

  const refresh = useMemo(() => {
    if (!adapter) return () => {}
    return () => {
      const entry = getOrCreateEntry(adapter.providerId)
      void fetchProvider(adapter, entry, true)
    }
  }, [adapter])

  return {
    snapshot,
    loading: entrySnapshot.loading,
    refresh,
  }
}

/** Test-only helper to clear cached provider entries between unit tests. */
export function resetSessionQuotaCacheForTest(): void {
  for (const entry of entries.values()) {
    if (entry.timer !== null) window.clearInterval(entry.timer)
  }
  entries.clear()
}
