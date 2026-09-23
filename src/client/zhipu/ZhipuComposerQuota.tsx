import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ZhipuWebStatus } from '../../shared/zhipu-contracts.ts'
import type { SnapshotStore } from '../store.ts'
import { NS_ZHIPU } from './locales.ts'

const API = '/zhipu/api'

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
  PropsLocale<typeof NS_ZHIPU> & {
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
 * A Coding Plan is bounded by two windows at once, and the one closer to
 * exhaustion is what the user needs to see: the 5-hour window can be spent
 * while the weekly one has room, and the reverse. So the tightest *remaining*
 * fraction wins, and its window names the tooltip.
 */
export function selectBadgeFacts(status: ZhipuWebStatus | null): BadgeFacts | null {
  const quota = status?.quota
  if (quota === null || quota === undefined) {
    return { text: '—', tooltip: 'GLM Coding Plan quota unavailable — click to refresh', level: 'normal' }
  }

  let tightest: { label: string; remaining: number } | null = null
  for (const window of quota.windows) {
    if (window.remainingFraction === null) continue
    if (tightest === null || window.remainingFraction < tightest.remaining) {
      tightest = { label: window.label, remaining: window.remainingFraction }
    }
  }
  if (tightest === null) {
    return { text: '—', tooltip: 'GLM Coding Plan quota unavailable — click to refresh', level: 'normal' }
  }

  const remaining = Math.round(tightest.remaining * 100)
  return {
    text: `${remaining}%`,
    tooltip: `[GLM Coding Plan] ${tightest.label}: ${remaining}% left`,
    level: remaining <= 5 ? 'danger' : remaining <= 20 ? 'warning' : 'normal',
  }
}

export function ZhipuComposerQuota({ directory, loadModelDirectory }: Props): React.JSX.Element | null {
  const modelState = useStore(directory)
  const [status, setStatus] = useState<ZhipuWebStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(false)
  const selected = modelState.current
  const isZhipu = selected?.provider === 'zhipu-coding-plan'

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
        ? await fetchApi<ZhipuWebStatus>('/quota', { method: 'POST' })
        : await fetchApi<ZhipuWebStatus>('/status')
      if (mountedRef.current) setStatus(data)
    } catch {
      // best-effort: the settings card reports the actionable error
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isZhipu) return
    void fetchStatus(false)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchStatus(false)
    }, 60_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [fetchStatus, isZhipu])

  const facts = useMemo(() => selectBadgeFacts(status), [status])

  if (!isZhipu || !status?.authenticated || facts === null) return null

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
