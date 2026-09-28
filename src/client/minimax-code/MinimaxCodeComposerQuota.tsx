import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  MINIMAX_CODE_PROVIDER_ID,
  type MinimaxCodeWebStatus,
} from '../../shared/minimax-code-contracts.ts'
import type { SnapshotStore } from '../store.ts'
import { get } from './api.ts'
import { NS_MINIMAX_CODE } from './locales.ts'

type Props = PropsRuntime<'conversation.input.right'> &
  PropsLocale<typeof NS_MINIMAX_CODE> & {
    directory: SnapshotStore<ModelDirectoryState>
    loadModelDirectory: () => void
  }

interface BadgeFacts {
  text: string
  tooltip: string
  level: 'normal' | 'warning' | 'danger'
}

/**
 * Pick the badge facts for one status answer, or nothing at all.
 *
 * Quota is optional in the frozen contract and MiniMax Code exposes no usage
 * endpoint, so a status without quota means the badge has nothing to say: it is
 * not rendered, rather than showing a placeholder that would read as a broken
 * meter. Callers must treat null as "hide the badge".
 */
export function selectBadgeFacts(status: MinimaxCodeWebStatus | null): BadgeFacts | null {
  const quota = status?.quota
  if (quota === undefined) return null

  if (quota.usedPercent !== undefined && Number.isFinite(quota.usedPercent)) {
    const remaining = Math.max(0, Math.round(100 - quota.usedPercent))
    return {
      text: `${remaining}%`,
      tooltip: `[MiniMax Code] ${quota.label}: ${remaining}% left`,
      level: remaining <= 5 ? 'danger' : remaining <= 20 ? 'warning' : 'normal',
    }
  }

  // A quota without a percentage still names something (a plan, a window), so
  // it is shown as text instead of a number.
  return { text: quota.label, tooltip: `[MiniMax Code] ${quota.label}`, level: 'normal' }
}

export function MinimaxCodeComposerQuota({ t, directory, loadModelDirectory }: Props): React.JSX.Element | null {
  const modelState = useStore(directory)
  const [status, setStatus] = useState<MinimaxCodeWebStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(false)
  const selected = modelState.current
  const isMinimaxCode = selected?.provider === MINIMAX_CODE_PROVIDER_ID

  useEffect(() => {
    loadModelDirectory()
  }, [loadModelDirectory])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const fetchStatus = useCallback(async () => {
    if (!mountedRef.current) return
    setLoading(true)
    try {
      // This line has no separate quota route: /status carries the optional
      // quota snapshot, and a status without one is a normal answer.
      const data = await get<MinimaxCodeWebStatus>('/status')
      if (mountedRef.current) setStatus(data)
    } catch {
      // best-effort: the settings card reports the actionable error
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isMinimaxCode) return
    void fetchStatus()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchStatus()
    }, 60_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [fetchStatus, isMinimaxCode])

  const facts = useMemo(() => selectBadgeFacts(status), [status])

  // No quota on this line means no badge at all — the graceful degradation the
  // frozen contract asks for.
  if (!isMinimaxCode || !status?.authenticated || facts === null) return null

  return (
    <span
      className="dsha-composer-quota"
      data-level={facts.level}
      title={facts.tooltip}
      aria-label={facts.tooltip}
      onClick={() => void fetchStatus()}
    >
      <span className="dsha-composer-quota-label">{t('composerLabel')}</span>
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
