import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { KimiCodeWebStatus } from '../../shared/kimi-code-contracts.ts'
import { NS_KIMI_CODE } from './locales.ts'

const API = '/kimi-code/api'

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
  PropsLocale<typeof NS_KIMI_CODE> & {
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
 * The shortest window is the one a user spends down first and the one that
 * blocks work soonest, so it wins over the longer pools; the 7-day allowance
 * shows only when no 5-hour window is reported.
 */
export function selectBadgeFacts(status: KimiCodeWebStatus | null): BadgeFacts | null {
  const quota = status?.quota
  if (quota === null || quota === undefined) {
    return { text: '—', tooltip: '[Kimi Code] quota unavailable — click to refresh', level: 'normal' }
  }

  const window = [...(quota.windows ?? [])]
    .filter((candidate) => candidate.windowDurationMins !== null)
    .sort((a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity))[0]
    ?? quota.windows[0]

  if (window !== undefined) {
    const remaining = Math.max(0, 100 - window.usedPercent)
    return {
      text: `${remaining}%`,
      tooltip: `[Kimi Code] ${window.label}: ${remaining}% left`,
      level: remaining <= 5 ? 'danger' : remaining <= 20 ? 'warning' : 'normal',
    }
  }

  const wallet = quota.extraUsage
  if (wallet !== null && wallet !== undefined && wallet.balanceCents !== null) {
    const amount = (wallet.balanceCents / 100).toFixed(2)
    return {
      text: amount,
      tooltip: `[Kimi Code] booster wallet: ${amount} ${wallet.currency ?? ''}`.trim(),
      level: 'normal',
    }
  }

  return { text: '—', tooltip: '[Kimi Code] quota unavailable — click to refresh', level: 'normal' }
}

export function KimiCodeComposerQuota({ directory, loadModelDirectory }: Props): React.JSX.Element | null {
  const modelState = useStore(directory)
  const [status, setStatus] = useState<KimiCodeWebStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(false)
  const selected = modelState.current
  const isKimiCode = selected?.provider === 'kimi-code'

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
        ? await fetchApi<KimiCodeWebStatus>('/quota', { method: 'POST' })
        : await fetchApi<KimiCodeWebStatus>('/status')
      if (mountedRef.current) setStatus(data)
    } catch {
      // best-effort: the settings card reports the actionable error
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isKimiCode) return
    void fetchStatus(false)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchStatus(false)
    }, 60_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [fetchStatus, isKimiCode])

  const facts = useMemo(() => selectBadgeFacts(status), [status])

  if (!isKimiCode || !status?.authenticated || facts === null) return null

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
