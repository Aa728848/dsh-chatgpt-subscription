import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandCodeWebStatus } from '../../shared/command-code-contracts.ts'
import { NS_COMMAND_CODE } from './locales.ts'

const API = '/command-code/api'

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
  PropsLocale<typeof NS_COMMAND_CODE> & {
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
 * A bounded usage window is the number a user actually spends down, so it wins
 * over a credit balance; the balance shows only when no window is reported.
 */
export function selectBadgeFacts(status: CommandCodeWebStatus | null): BadgeFacts | null {
  const quota = status?.quota
  if (quota === null || quota === undefined) {
    return { text: '—', tooltip: 'Command Code quota unavailable — click to refresh', level: 'normal' }
  }

  const window = [...(quota.windows ?? [])].sort((a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity))[0]
  if (window !== undefined) {
    const remaining = Math.max(0, 100 - window.usedPercent)
    return {
      text: `${remaining}%`,
      tooltip: `[Command Code] ${window.label}: ${remaining}% left`,
      level: remaining <= 5 ? 'danger' : remaining <= 20 ? 'warning' : 'normal',
    }
  }

  const meter = (quota.meters ?? []).find((candidate) => candidate.remainingFraction !== null)
  if (meter !== undefined && meter.remainingFraction !== null) {
    const remaining = Math.round(meter.remainingFraction * 100)
    return {
      text: `${remaining}%`,
      tooltip: `[Command Code] ${meter.label}: ${remaining}% left`,
      level: remaining <= 5 ? 'danger' : remaining <= 20 ? 'warning' : 'normal',
    }
  }

  if (quota.unlimited) {
    return { text: '∞', tooltip: '[Command Code] Unlimited plan allowance', level: 'normal' }
  }
  if (quota.creditBalance !== null) {
    return { text: quota.creditBalance, tooltip: `[Command Code] Remaining credits: ${quota.creditBalance}`, level: 'normal' }
  }
  return { text: '—', tooltip: 'Command Code quota unavailable — click to refresh', level: 'normal' }
}

export function CommandCodeComposerQuota({ directory, loadModelDirectory }: Props): React.JSX.Element | null {
  const modelState = useStore(directory)
  const [status, setStatus] = useState<CommandCodeWebStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(false)
  const selected = modelState.current
  const isCommandCode = selected?.provider === 'command-code'

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
        ? await fetchApi<CommandCodeWebStatus>('/quota', { method: 'POST' })
        : await fetchApi<CommandCodeWebStatus>('/status')
      if (mountedRef.current) setStatus(data)
    } catch {
      // best-effort: the settings card reports the actionable error
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isCommandCode) return
    void fetchStatus(false)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchStatus(false)
    }, 60_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [fetchStatus, isCommandCode])

  const facts = useMemo(() => selectBadgeFacts(status), [status])

  if (!isCommandCode || !status?.authenticated || facts === null) return null

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
