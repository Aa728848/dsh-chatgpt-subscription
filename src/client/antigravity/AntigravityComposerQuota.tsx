import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AntigravityQuotaGroup, AntigravityModelBucket, AntigravityWebStatus } from '../../shared/antigravity-contracts.ts'
import { NS_ANTIGRAVITY } from './locales.ts'

const API = '/antigravity/api'

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
  PropsLocale<typeof NS_ANTIGRAVITY> & {
    directory: SnapshotStore<ModelDirectoryState>
    loadModelDirectory: () => void
  }

function selectQuotaBucketForModel(groups: AntigravityQuotaGroup[], modelId?: string) {
  if (!groups || groups.length === 0) return null
  const isClaudeOrGpt = modelId ? /claude|gpt/i.test(modelId) : false
  const targetGroup =
    groups.find((g) => {
      const match = /claude|gpt|3p/i.test(g.displayName)
      return isClaudeOrGpt ? match : !match
    }) || groups[0]

  if (!targetGroup || !targetGroup.buckets || targetGroup.buckets.length === 0) return null
  const shortBucket: AntigravityModelBucket =
    targetGroup.buckets.find((b: AntigravityModelBucket) => /5\s*小时|hour|5h/i.test(b.displayName)) || targetGroup.buckets[0]

  return {
    groupName: targetGroup.displayName,
    bucketName: shortBucket.displayName,
    remainingPercent: Math.round(shortBucket.remainingFraction * 100),
    resetTime: shortBucket.resetTime,
  }
}

function formatResetCountdown(resetTime?: string): string {
  if (!resetTime) return ''
  try {
    const diff = new Date(resetTime).getTime() - Date.now()
    if (diff <= 0) return '即将重置'
    const h = Math.floor(diff / 3600000)
    const m = Math.floor((diff % 3600000) / 60000)
    if (h > 0) return `${h}小时${m}分后重置`
    return `${m}分钟后重置`
  } catch {
    return ''
  }
}

export function AntigravityComposerQuota({ directory, loadModelDirectory }: Props): React.JSX.Element | null {
  const modelState = useStore(directory)
  const [status, setStatus] = useState<AntigravityWebStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(false)
  const selected = modelState.current
  const isAntigravity = selected?.provider === 'antigravity'

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
      const data = refresh
        ? await fetchApi<AntigravityWebStatus>('/quota', { method: 'POST' })
        : await fetchApi<AntigravityWebStatus>('/status')
      if (mountedRef.current) setStatus(data)
    } catch {
      // best-effort
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isAntigravity) return
    void fetchStatus(false)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchStatus(false)
    }, 60_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [fetchStatus, isAntigravity])

  const quotaInfo = useMemo(() => {
    const groups = status?.quota?.groups || []
    return selectQuotaBucketForModel(groups, selected?.model)
  }, [status?.quota?.groups, selected?.model])

  if (!isAntigravity || !status?.authenticated) return null

  const level =
    quotaInfo === null
      ? 'normal'
      : quotaInfo.remainingPercent <= 5
        ? 'danger'
        : quotaInfo.remainingPercent <= 20
          ? 'warning'
          : 'normal'

  const countdown = quotaInfo?.resetTime ? formatResetCountdown(quotaInfo.resetTime) : ''
  const tooltip = quotaInfo
    ? `[Antigravity] ${quotaInfo.groupName} - ${quotaInfo.bucketName}: 剩余 ${quotaInfo.remainingPercent}%${countdown ? ' (' + countdown + ')' : ''}，点击刷新`
    : '点击刷新 Antigravity 配额'

  return (
    <span
      className="dsha-composer-quota"
      data-level={level}
      title={tooltip}
      aria-label={tooltip}
      onClick={() => void fetchStatus(true)}
    >
      <span className="dsha-composer-quota-label">额度</span>
      <strong className="dsha-composer-quota-val">
        {loading ? '…' : quotaInfo === null ? '—' : `${quotaInfo.remainingPercent}%`}
      </strong>
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