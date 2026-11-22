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
  /**
   * The remaining share (0–100) to draw as a ring gauge, for a line whose status
   * states one. It is optional on purpose: most lines report only a number, and
   * the capsule then leads with a plain status dot — the ring exists for the
   * lines that can state a remaining share, never as a guess.
   */
  percent?: number | null
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

  return <QuotaCapsule
    label={label}
    text={facts.text}
    tooltip={facts.tooltip}
    level={facts.level}
    percent={facts.percent}
    loading={loading}
    onRefresh={() => void fetchStatus(true)}
  />
}

export interface QuotaCapsuleProps {
  label: string
  text: string
  tooltip: string
  level: ComposerQuotaFacts['level']
  percent?: number | null
  /** A refresh is in flight: the last number stays put and the indicator pulses. */
  loading?: boolean
  /** Present for a capsule that refreshes on click (and on Enter / Space). */
  onRefresh?: () => void
}

/**
 * The capsule itself, shared by every line's badge and by the Codex one.
 *
 * It leads with a health indicator in the level's tone: a ring gauge for a line
 * that states its remaining share, a status dot for one that only reports a
 * number. Both repeat what the tooltip already says in words, so they stay out
 * of the accessibility tree. A refresh keeps the previous number on screen —
 * swapping it for an ellipsis made the capsule change width on every poll.
 */
export function QuotaCapsule({ label, text, tooltip, level, percent, loading = false, onRefresh }: QuotaCapsuleProps): React.JSX.Element {
  const share = typeof percent === 'number' && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null
  const interactive = onRefresh !== undefined
  return <span
    className="dsha-composer-quota"
    data-level={level}
    data-loading={loading ? 'true' : undefined}
    aria-busy={loading || undefined}
    title={tooltip}
    aria-label={tooltip}
    role={interactive ? 'button' : undefined}
    tabIndex={interactive ? 0 : undefined}
    onClick={onRefresh}
    onKeyDown={interactive
      ? (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onRefresh()
        }
      : undefined}
  >
    {share === null
      ? <i className="dsha-composer-quota-dot" aria-hidden="true" />
      : <svg className="dsha-composer-quota-ring" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle className="dsha-composer-quota-ring-track" cx="8" cy="8" r="6" pathLength={100} />
          <circle
            className="dsha-composer-quota-ring-fill"
            cx="8"
            cy="8"
            r="6"
            pathLength={100}
            strokeDasharray={`${share} 100`}
            strokeLinecap={share > 0 ? 'round' : 'butt'}
          />
        </svg>}
    <span className="dsha-composer-quota-label">{label}</span>
    <strong className="dsha-composer-quota-val">{text}</strong>
  </span>
}
