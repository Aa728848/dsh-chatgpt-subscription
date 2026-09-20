import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkBuddyWebStatus } from '../../shared/workbuddy-contracts.ts'
import type { SnapshotStore } from '../store.ts'
import { NS_WORKBUDDY } from './locales.ts'

const API = '/workbuddy/api'

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  const json = (await res.json()) as { ok: boolean; value?: T; error?: string }
  if (!res.ok || !json.ok) {
    throw new Error(json.error || `HTTP ${res.status}`)
  }
  return json.value as T
}

type Props = PropsRuntime<'conversation.input.right'> &
  PropsLocale<typeof NS_WORKBUDDY> & {
    directory: SnapshotStore<ModelDirectoryState>
    loadModelDirectory: () => void
  }

interface BadgeFacts {
  text: string
  tooltip: string
  level: 'normal' | 'warning' | 'danger'
}

/**
 * Pick the most meaningful number for the badge.
 *
 * A bounded allowance is what a user spends down, so it wins over a bare credit
 * balance; the balance shows only when no percentage is reported. The billing
 * payload reports both a cycle meter and a package meter, and the cycle meter
 * is the one that actually resets, so it is preferred when both exist.
 */
export function selectBadgeFacts(status: WorkBuddyWebStatus | null): BadgeFacts | null {
  const quota = status?.quota
  if (quota === null || quota === undefined) {
    return { text: '—', tooltip: 'WorkBuddy quota unavailable — click to refresh', level: 'normal' }
  }

  const meter = (quota.meters ?? []).find((candidate) => candidate.id === 'cycle' && candidate.remainingFraction !== null)
    ?? (quota.meters ?? []).find((candidate) => candidate.remainingFraction !== null)
  if (meter !== undefined && meter.remainingFraction !== null) {
    const remaining = Math.round(meter.remainingFraction * 100)
    return {
      text: `${remaining}%`,
      tooltip: `[WorkBuddy] ${meter.label}: ${remaining}% left`,
      level: remaining <= 5 ? 'danger' : remaining <= 20 ? 'warning' : 'normal',
    }
  }

  if (quota.remainingCredits !== null) {
    return {
      text: String(quota.remainingCredits),
      tooltip: `[WorkBuddy] Remaining credits: ${quota.remainingCredits}`,
      level: 'normal',
    }
  }
  return { text: '—', tooltip: 'WorkBuddy quota unavailable — click to refresh', level: 'normal' }
}

export function WorkBuddyComposerQuota({ directory, loadModelDirectory }: Props): React.JSX.Element | null {
  const modelState = useStore(directory)
  const [status, setStatus] = useState<WorkBuddyWebStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(false)
  const selected = modelState.current
  const isWorkBuddy = selected?.provider === 'workbuddy'

  useEffect(() => {
    loadModelDirectory()
  }, [loadModelDirectory])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const fetchStatus = useCallback(async (refresh = false) => {
    if (!mountedRef.current) return
    setLoading(true)
    try {
      // The host refreshes a stale quota cache while serving /status; only an
      // explicit click asks for the forced refresh, so a poll never doubles the
      // upstream request count.
      const data = refresh
        ? await fetchApi<WorkBuddyWebStatus>('/quota', { method: 'POST' })
        : await fetchApi<WorkBuddyWebStatus>('/status')
      if (mountedRef.current) setStatus(data)
    } catch {
      // best-effort: the settings card reports the actionable error
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isWorkBuddy) return
    void fetchStatus(false)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchStatus(false)
    }, 60_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [fetchStatus, isWorkBuddy])

  const facts = useMemo(() => selectBadgeFacts(status), [status])

  if (!isWorkBuddy || !status?.authenticated || facts === null) return null

  return (
    <span
      className="dsha-composer-quota"
      data-level={facts.level}
      title={facts.tooltip}
      aria-label={facts.tooltip}
      onClick={() => void fetchStatus(true)}
    >
      <span className="dsha-composer-quota-label">额度</span>
      <strong className="dsha-composer-quota-val">{loading ? '…' : facts.text}</strong>
    </span>
  )
}

function useStore<T>(store: SnapshotStore<T>): T {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  )
}
