import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CODEX_CHATGPT_PROVIDER_ID } from '../compat.ts'
import type { PluginStatusDto } from '../shared/contracts.ts'
import { SubscriptionApi } from './api.ts'
import { QuotaCapsule, quotaLevel } from './common/ComposerQuotaBadge.tsx'
import { useStore } from './common/use-store.ts'
import { NS } from './locales.ts'
import { selectQuotaForModel } from './quota.ts'
import type { SnapshotStore } from './store.ts'

type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS> & {
  api: SubscriptionApi
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory: () => void
}

export function CodexComposerQuota({ api, directory, loadModelDirectory, t }: Props): React.JSX.Element | null {
  const modelState = useStore(directory)
  const [status, setStatus] = useState<PluginStatusDto | null>(null)
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(false)
  const selected = modelState.current
  const isCodex = selected?.provider === CODEX_CHATGPT_PROVIDER_ID

  useEffect(() => {
    loadModelDirectory()
  }, [loadModelDirectory])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!isCodex) return
    let disposed = false
    const refresh = async (): Promise<void> => {
      setLoading(true)
      try {
        const next = await api.status()
        if (!disposed && mountedRef.current) setStatus(next)
      } catch {
        if (!disposed && mountedRef.current) setStatus(null)
      } finally {
        if (!disposed && mountedRef.current) setLoading(false)
      }
    }
    void refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 60_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [api, isCodex])

  const quota = useMemo(() => selectQuotaForModel(status?.quota, selected?.model), [selected?.model, status?.quota])
  if (!isCodex || status?.preferences.quickQuotaVisible !== true) return null
  return <QuotaCapsule
    label={t('quickQuotaLabel')}
    text={quota === null ? (loading ? t('quickQuotaLoading') : '—') : formatPercent(quota.remainingPercent)}
    tooltip={quota === null ? t('quickQuotaLoading') : `${t('quickQuotaLabel')}: ${formatPercent(quota.remainingPercent)}`}
    level={quota === null ? 'normal' : quotaLevel(quota.remainingPercent)}
    percent={quota?.remainingPercent ?? null}
    loading={loading && quota !== null}
  />
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)}%`
}
