/**
 * The composer badge every subscription line shows beside the input.
 *
 * Six of these were near-identical copies: the same mount guard, the same 60 s
 * poll that only ticks while the tab is visible, the same "inert unless the
 * conversation is on this provider" rule, the same markup. What differed was the
 * part worth reading — how each line picks its most meaningful number — and that
 * is the only thing a line still supplies.
 *
 * Two details this shared shape depends on:
 *
 *   - the callbacks are held in refs. Every caller hands them over as an inline
 *     arrow, and a callback in the dependency array would restart the interval —
 *     and refetch — on every render. The copies this replaced were only safe
 *     because each was rendered with a stable prop, which is a property of the
 *     call site rather than of the badge;
 *   - `authenticated` is part of the status contract rather than a predicate a
 *     line could forget, so a signed-out line can never leave a stale badge up.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SnapshotStore } from '../store.ts'
import { useStore } from './use-store.ts'

export interface ComposerQuotaFacts {
  /** The number the badge shows, already formatted. */
  text: string
  /** What the hover and the screen reader say. */
  tooltip: string
  level: 'normal' | 'warning' | 'danger'
}

/** The shared grading: 5% or less is critical, 20% or less warns. */
export function quotaLevel(remainingPercent: number): ComposerQuotaFacts['level'] {
  return remainingPercent <= 5 ? 'danger' : remainingPercent <= 20 ? 'warning' : 'normal'
}

export interface ComposerQuotaBadgeProps<Status extends { authenticated: boolean }> {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory(): void
  /** The provider id this badge speaks for; it renders for no other. */
  providerId: string
  /** One status read; `true` asks the host for a forced refresh. */
  readStatus(refresh: boolean): Promise<Status>
  /**
   * The line's own number picker; null means there is nothing to show.
   *
   * `modelId` is the conversation's selected model, which one line needs: its
   * allowance is reported per model group, so the number to show depends on
   * which group that model belongs to.
   */
  selectFacts(status: Status | null, modelId: string | undefined): ComposerQuotaFacts | null
  /** Label in front of the number, from the line's own dictionary. */
  label: string
}

export function ComposerQuotaBadge<Status extends { authenticated: boolean }>(
  props: ComposerQuotaBadgeProps<Status>,
): React.JSX.Element | null {
  const { directory, loadModelDirectory, providerId, label } = props
  const modelState = useStore(directory)
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(false)
  // See the header: identity churn in these two must not restart the poll.
  const readRef = useRef(props.readStatus)
  const selectRef = useRef(props.selectFacts)
  readRef.current = props.readStatus
  selectRef.current = props.selectFacts

  const selected = modelState.current
  const isSelected = selected?.provider === providerId

  useEffect(() => {
    loadModelDirectory()
  }, [loadModelDirectory])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const fetchStatus = useCallback(async (refresh: boolean) => {
    if (!mountedRef.current) return
    setLoading(true)
    try {
      // The host refreshes a stale quota cache while serving the ordinary read;
      // only an explicit click asks for the forced one, so a poll never doubles
      // the upstream request count.
      const data = await readRef.current(refresh)
      if (mountedRef.current) setStatus(data)
    } catch {
      // best-effort: the settings card reports the actionable error
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isSelected) return
    void fetchStatus(false)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchStatus(false)
    }, 60_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [fetchStatus, isSelected])

  const facts = useMemo(() => selectRef.current(status, selected?.model), [status, selected?.model])

  // Inert unless the conversation is actually on this provider: the badge is one
  // per line and six of them must never be visible at once.
  if (!isSelected || status === null || !status.authenticated || facts === null) return null

  return <span
    className="dsha-composer-quota"
    data-level={facts.level}
    title={facts.tooltip}
    aria-label={facts.tooltip}
    onClick={() => void fetchStatus(true)}
  >
    <span className="dsha-composer-quota-label">{label}</span>
    <strong className="dsha-composer-quota-val">{loading ? '…' : facts.text}</strong>
  </span>
}
