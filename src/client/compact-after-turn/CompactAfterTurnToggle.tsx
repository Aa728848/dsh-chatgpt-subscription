/**
 * The "compact after this turn" row of the composer's model menu.
 *
 * The switch is a one-shot owned by the Host (see
 * `src/host/compact-after-turn/`): turning it on arms the session, the Host
 * compacts once when the turn ends and then turns it off by itself. The row only
 * mirrors that state — it polls while the menu is open, because the switch flips
 * back without the user touching it — and is locked while the compaction runs.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  COMPACT_AFTER_TURN_PATH,
  type CompactAfterTurnErrorCode,
  type CompactAfterTurnStateDto,
} from '../../shared/compact-after-turn.ts'
import type { CompactAfterTurnLocaleKey } from './locales.ts'

/** How often the open menu re-reads the state. */
export const COMPACT_AFTER_TURN_POLL_MS = 1_500

type Translate = (key: CompactAfterTurnLocaleKey, params?: Record<string, string>) => string

export interface CompactAfterTurnToggleProps {
  sessionId: string
  /** The menu refuses changes (for example while a model selection saves). */
  locked: boolean
  reportFailure: (message: string) => void
  t: Translate
  /** Test seam; production uses {@link compactAfterTurnApi}. */
  api?: CompactAfterTurnApi
}

export interface CompactAfterTurnApi {
  read(sessionId: string): Promise<CompactAfterTurnStateDto>
  write(sessionId: string, armed: boolean): Promise<CompactAfterTurnStateDto>
}

class CompactAfterTurnRequestError extends Error {
  constructor(readonly code: CompactAfterTurnErrorCode | 'unknown', message: string) {
    super(message)
  }
}

async function call(url: string, init?: RequestInit): Promise<CompactAfterTurnStateDto> {
  const response = await fetch(url, { ...init, credentials: 'same-origin' })
  let envelope: { ok?: boolean; value?: CompactAfterTurnStateDto; error?: { code?: CompactAfterTurnErrorCode; message?: string } } | null = null
  try {
    envelope = await response.json()
  } catch {
    // A Host without this route answers with a non-JSON 404.
  }
  if (!response.ok || envelope?.ok !== true || envelope.value === undefined) {
    throw new CompactAfterTurnRequestError(envelope?.error?.code ?? 'unknown', envelope?.error?.message ?? `HTTP ${response.status}`)
  }
  return envelope.value
}

export const compactAfterTurnApi: CompactAfterTurnApi = {
  read: (sessionId) => call(`${COMPACT_AFTER_TURN_PATH}?session=${encodeURIComponent(sessionId)}`),
  write: (sessionId, armed) => call(COMPACT_AFTER_TURN_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, armed }),
  }),
}

export function CompactAfterTurnToggle({ sessionId, locked, reportFailure, t, api = compactAfterTurnApi }: CompactAfterTurnToggleProps): React.JSX.Element | null {
  const [state, setState] = useState<CompactAfterTurnStateDto | null>(null)
  const [pending, setPending] = useState(false)
  const mounted = useRef(true)
  const apiRef = useRef(api)
  apiRef.current = api

  const refresh = useCallback(async () => {
    try {
      const next = await apiRef.current.read(sessionId)
      if (mounted.current) setState(next)
    } catch {
      // A Host without the route (or a transient failure) leaves the row hidden
      // or at its last known state; the next poll tries again.
    }
  }, [sessionId])

  useEffect(() => {
    mounted.current = true
    setState(null)
    void refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, COMPACT_AFTER_TURN_POLL_MS)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
    }
  }, [refresh])

  if (state === null || state.sessionId !== sessionId) return null

  const compacting = state.phase === 'compacting'
  const checked = state.phase !== 'off'
  const disabled = locked || pending || compacting || (!state.available && !checked)
  const toggle = (): void => {
    if (disabled) return
    setPending(true)
    apiRef.current.write(sessionId, !checked).then((next) => {
      if (mounted.current) setState(next)
    }, (error: unknown) => {
      const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
      reportFailure(code === 'busy'
        ? t('errorBusy')
        : code === 'unavailable'
          ? t('unavailable')
          : t('errorFailed', { message: error instanceof Error ? error.message : String(error) }))
      void refresh()
    }).finally(() => {
      if (mounted.current) setPending(false)
    })
  }

  const notes = [t('hint')]
  if (!state.available) notes.push(t('unavailable'))
  if (state.last !== null) {
    notes.push(state.last.kind === 'compacted'
      ? t('lastCompacted')
      : state.last.kind === 'nothing'
        ? t('lastNothing')
        : t('lastFailed', { detail: state.last.detail ?? '' }))
  }
  const explanation = notes.join('\n')
  const stateText = compacting ? t('stateCompacting') : state.phase === 'armed' ? t('stateArmed') : ''

  return <div className="dshcat-row" data-phase={state.phase}>
    <span className="dshcat-label">
      <span className="dshcat-name">{t('label')}</span>
      <InfoTip label={t('infoLabel')} text={explanation} />
    </span>
    {stateText !== '' && <span className="dshcat-state" aria-live="polite">{stateText}</span>}
    <button
      type="button"
      role="switch"
      className="dshcat-switch"
      aria-checked={checked}
      aria-label={t('label')}
      aria-description={explanation}
      aria-busy={compacting || undefined}
      disabled={disabled}
      onClick={toggle}
    />
  </div>
}

/** Hover delay of the explanation bubble, the one the host's menu rows use. */
export const INFO_TIP_DELAY_MS = 300

/**
 * The ⓘ button beside the row's name and its explanation bubble, drawn the way
 * the host's Tooltip draws one above an anchor: hover (after a short delay) or
 * keyboard focus shows it, leaving or blurring hides it. The bubble goes under
 * document.body so the menu card's clipping cannot cut it off.
 */
function InfoTip({ label, text }: { label: string; text: string }): React.JSX.Element {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const bubbleId = useId()
  const show = (): void => {
    const rect = anchor.current?.getBoundingClientRect()
    if (rect !== undefined) setPosition({ left: rect.left + rect.width / 2, top: rect.top - 8 })
  }
  const hide = (): void => {
    window.clearTimeout(timer.current)
    setPosition(null)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return <>
    <button
      ref={anchor}
      type="button"
      className="dshcat-info"
      aria-label={label}
      aria-describedby={position === null ? undefined : bubbleId}
      // The row's switch owns the row's press; the icon only explains.
      onClick={(event) => { event.stopPropagation() }}
      onPointerEnter={() => {
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(show, INFO_TIP_DELAY_MS)
      }}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 7.2v3.6" />
        <circle cx="8" cy="5.1" r="0.3" fill="currentColor" />
      </svg>
    </button>
    {position !== null && createPortal(
      <div id={bubbleId} role="tooltip" className="dshcat-tip" style={{ left: position.left, top: position.top }}>{text}</div>,
      document.body,
    )}
  </>
}
