import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeWebStatus } from '../../shared/claude-contracts.ts'
import type { SnapshotStore } from '../store.ts'
import { NS_CLAUDE } from './locales.ts'

const API = '/claude/api'

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
  PropsLocale<typeof NS_CLAUDE> & {
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
 * A subscription is bounded by several windows at once — a 5-hour one and a
 * weekly one, and sometimes a per-model weekly one as well. They are not
 * interchangeable: the short window can be spent while the long one has room and
 * the reverse, so the TIGHTEST *remaining* percentage is what the badge shows
 * and its own label names the tooltip. Choosing "the shortest window" instead
 * would be a guess about which one runs out first, and the payload already
 * answers that.
 *
 * NOTE ON DIRECTION: the wire reports `usedPercent`, which is PERCENT USED, so
 * remaining is 100 - used. A window at 0% used is the normal empty state and
 * grades as 'normal', not as an error.
 */
export function selectBadgeFacts(status: ClaudeWebStatus | null): BadgeFacts | null {
  const quota = status?.quota
  if (quota === null || quota === undefined) {
    return { text: '—', tooltip: '[Claude] quota unavailable — click to refresh', level: 'normal' }
  }

  let tightest: { label: string; remaining: number } | null = null
  for (const window of quota.windows) {
    // A null is "the source stated nothing" — skipped rather than read as a
    // fully-spent window, which would be a fabricated alarm.
    const remaining = window.remainingPercent
      ?? (window.usedPercent === null ? null : 100 - window.usedPercent)
    if (remaining === null) continue
    if (tightest === null || remaining < tightest.remaining) {
      tightest = { label: window.label, remaining }
    }
  }
  if (tightest === null) {
    return { text: '—', tooltip: '[Claude] quota unavailable — click to refresh', level: 'normal' }
  }

  const remaining = Math.round(tightest.remaining)
  return {
    text: `${remaining}%`,
    tooltip: `[Claude] ${tightest.label}: ${remaining}% left`,
    level: remaining <= 5 ? 'danger' : remaining <= 20 ? 'warning' : 'normal',
  }
}

export function ClaudeComposerQuota({ directory, loadModelDirectory }: Props): React.JSX.Element | null {
  const modelState = useStore(directory)
  const [status, setStatus] = useState<ClaudeWebStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(false)
  const selected = modelState.current
  const isClaude = selected?.provider === 'claude-subscription'

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
        ? await fetchApi<ClaudeWebStatus>('/quota', { method: 'POST' })
        : await fetchApi<ClaudeWebStatus>('/status')
      if (mountedRef.current) setStatus(data)
    } catch {
      // best-effort: the settings card reports the actionable error
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isClaude) return
    void fetchStatus(false)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchStatus(false)
    }, 60_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [fetchStatus, isClaude])

  const facts = useMemo(() => selectBadgeFacts(status), [status])

  // Inert unless the conversation is actually on this provider: the badge is one
  // per line and six of them must never be visible at once.
  if (!isClaude || !status?.authenticated || facts === null) return null

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
