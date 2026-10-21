/**
 * The hub's update control: one 28px ring-icon button at the right end of the
 * section header, with a line of 11px text to its left saying which version is
 * running and what the last check found. The icon carries no text label — its
 * name is the state-dependent `aria-label`, which the button also mirrors as a
 * hover title — so the control stays quiet until the pointer is on it.
 *
 * Nothing is requested on mount. Opening the settings page costs exactly the one
 * overview request it always did, and the registry is asked only when the user
 * asks it to be — a settings page that reached out to npm on every render would
 * be a network round trip nobody requested and, on a machine behind a proxy that
 * is down, a spinner that never settles.
 *
 * The four outcomes the card renders are all derivable from the check's DTO:
 * already latest, a newer version one click away, a newer version that can only
 * be installed by hand (with the command to copy), and a check that failed.
 * Failures of either request are shown in place, in the same line, as small red
 * text — never an alert, which would take the user out of the page they were
 * reading to say something they can read here.
 *
 * An update that succeeded says whether a restart is still pending and whether
 * the old copy had to be removed first, both read from the route's answer rather
 * than assumed. An update that failed after that removal also says what happened
 * to the previous version, including the case where it could not be put back.
 */
import { useCallback, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ApiEnvelope } from '../../shared/contracts.ts'
import { UPDATE_APPLY_PATH, UPDATE_CHECK_PATH } from '../../shared/update-contracts.ts'
import type { UpdateApplyDto, UpdateCheckDto, UpdateFailureDto, UpdateRollback } from '../../shared/update-contracts.ts'
import { formatPoolLabel } from '../common/account-pool-labels.ts'
import type { NS } from '../locales.ts'

type Translate = PropsLocale<typeof NS>['t']

interface Props {
  t: Translate
}

/** Where the control is in its own cycle. */
type Phase = 'idle' | 'checking' | 'checked' | 'applying' | 'applied'

/**
 * The button's whole face: a ring arrow, drawn in `currentColor` so the button's
 * own color (tertiary, primary on hover) is the only color it ever has. The class
 * is what the busy state animates, so the rotation is a stylesheet fact rather
 * than an inline style on the icon.
 */
const REFRESH_SVG = '<svg class="dsh-hub-update-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33"/><path d="M14 2v3.33h-3.33"/></svg>'

/** A refused update, carrying the route's machine-readable code so the card can word it. */
class UpdateApplyError extends Error {
  constructor(
    readonly code: string | null,
    message: string,
    /** Whether the previous version was put back, when the failure happened after a removal. */
    readonly rollback?: UpdateRollback,
    /** The version that was restored, present exactly when `rollback` is `restored`. */
    readonly restoredVersion?: string,
  ) {
    super(message)
    this.name = 'UpdateApplyError'
  }
}

async function fetchCheck(): Promise<UpdateCheckDto> {
  const response = await fetch(UPDATE_CHECK_PATH, { credentials: 'same-origin' })
  const envelope = await response.json() as ApiEnvelope<UpdateCheckDto>
  if (!response.ok || !envelope.ok) {
    throw new Error(envelope.ok ? `Request failed (${response.status})` : envelope.error.message)
  }
  return envelope.value
}

/**
 * Ask the Host to install the published version.
 *
 * The request carries no package name or version: the server installs the spec
 * it owns, so a caller cannot choose what lands in the profile.
 */
async function postApply(): Promise<UpdateApplyDto> {
  const response = await fetch(UPDATE_APPLY_PATH, { method: 'POST', credentials: 'same-origin' })
  // The apply route answers exactly two shapes: the success envelope, or the
  // update failure DTO that also carries the rollback state. Typing the union
  // that way keeps that state readable here without a cast.
  const body = await response.json() as { ok: true; value: UpdateApplyDto } | UpdateFailureDto
  if (!body.ok) {
    throw new UpdateApplyError(body.error.code, body.error.message, body.error.rollback, body.error.restoredVersion)
  }
  if (!response.ok) throw new UpdateApplyError(null, `Request failed (${response.status})`)
  return body.value
}

/**
 * What a successful update should say.
 *
 * Two facts decide the wording and neither may be assumed: whether a restart is
 * still pending (the Host's own `application` answer), and whether the update had
 * to remove the installed copy first, which is worth naming because it is the one
 * path that leaves the plugin briefly uninstalled.
 */
function appliedText(applied: UpdateApplyDto, t: Translate): string {
  const key = applied.restartRequired
    ? applied.removedFirst ? 'hubUpdateInstalledReplaced' : 'hubUpdateInstalled'
    : applied.removedFirst ? 'hubUpdateInstalledReplacedLive' : 'hubUpdateInstalledLive'
  return formatPoolLabel(t(key), { version: applied.installed })
}

/**
 * The red line a refused update leaves behind.
 *
 * The route's message is carried through untouched — it is the only text that
 * says what pnpm did — and the rollback state is prefixed to it, because "the
 * update failed" and "the update failed and your plugin is gone" are not the same
 * message and a user has to be able to tell them apart.
 */
function failureText(failure: unknown, t: Translate): string {
  if (!(failure instanceof UpdateApplyError)) {
    return failure instanceof Error ? failure.message : String(failure)
  }
  if (failure.rollback === 'restored') {
    return `${formatPoolLabel(t('hubUpdateFailedRestored'), { version: failure.restoredVersion ?? '' })} ${failure.message}`
  }
  if (failure.rollback === 'failed') {
    return `${t('hubUpdateFailedRollbackFailed')}: ${failure.message}`
  }
  if (failure.rollback === 'skipped') {
    return `${t('hubUpdateFailedRollbackSkipped')}: ${failure.message}`
  }
  return failure.message
}

/** The one line of text beside the icon: what the last answer means. */
function statusOf(check: UpdateCheckDto, applied: UpdateApplyDto | null, t: Translate): { text: string; danger: boolean } | null {
  if (applied !== null) return { text: appliedText(applied, t), danger: false }
  if (check.reason === 'registry-unreachable') return { text: t('hubUpdateCheckFailed'), danger: true }
  if (check.current === null) {
    // The manifest could not be located. Saying "up to date" here would be a
    // claim about a version this process never read.
    return { text: formatPoolLabel(t('hubUpdateLatestWithUnknownCurrent'), { version: check.latest ?? '' }), danger: false }
  }
  if (!check.updateAvailable) return { text: formatPoolLabel(t('hubUpdateUpToDate'), { version: check.current }), danger: false }
  const values = { version: check.latest ?? '', current: check.current }
  if (check.canApply) return { text: formatPoolLabel(t('hubUpdateAvailable'), values), danger: false }
  if (check.reason === 'development-install') {
    return { text: formatPoolLabel(t('hubUpdateDevelopmentInstall'), values), danger: false }
  }
  if (check.reason === 'plugin-manager-missing') {
    return { text: formatPoolLabel(t('hubUpdatePluginManagerMissing'), values), danger: false }
  }
  return { text: formatPoolLabel(t('hubUpdateManualOnly'), values), danger: false }
}

export function UpdateCheck({ t }: Props): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [check, setCheck] = useState<UpdateCheckDto | null>(null)
  const [applied, setApplied] = useState<UpdateApplyDto | null>(null)
  const [error, setError] = useState<string | null>(null)

  const busy = phase === 'checking' || phase === 'applying'
  // The button becomes an update button only for an offer the Host says it can
  // perform; every other answer leaves it a plain "check again".
  const canOfferApply = applied === null && check !== null && check.updateAvailable && check.canApply

  const runCheck = useCallback(async (): Promise<void> => {
    setPhase('checking')
    setError(null)
    setApplied(null)
    try {
      const value = await fetchCheck()
      setCheck(value)
      setPhase('checked')
    } catch (failure) {
      // A failed check is state, not an exception: the previous answer is stale
      // now, so it goes away rather than sitting under a red line as if current.
      setCheck(null)
      setError(failure instanceof Error ? failure.message : String(failure))
      setPhase('idle')
    }
  }, [])

  const runApply = useCallback(async (): Promise<void> => {
    setPhase('applying')
    setError(null)
    try {
      const value = await postApply()
      setApplied(value)
      setPhase('applied')
    } catch (failure) {
      setError(failureText(failure, t))
      setPhase('checked')
    }
  }, [t])

  // The icon has no text, so its accessible name (and hover title) is the only
  // place the state is named: it follows the same four outcomes the label did.
  const label = phase === 'checking'
    ? t('hubUpdateChecking')
    : phase === 'applying'
      ? t('hubUpdateApplying')
      : canOfferApply
        ? formatPoolLabel(t('hubUpdateApply'), { version: check?.latest ?? '' })
        : t('hubUpdateCheck')

  const status = check === null ? null : statusOf(check, applied, t)
  // The command is the escape hatch, so it appears wherever the button cannot
  // act. A failed check does not show it: there is no known newer version to
  // install, and the network is what failed, not the install posture.
  const showCommand = check !== null && check.updateAvailable && !check.canApply
    && check.reason !== 'registry-unreachable'

  // Everything that can grow sits to the left of the icon, and the icon is the
  // row's last element: the header row is right-aligned, so the icon keeps the
  // row's right edge whether there is no answer yet, a short "up to date" line,
  // or a long error, and that text grows leftwards into the space instead.
  return <div className="dsh-hub-update">
    <div className="dsh-hub-update-row">
      {status === null ? null : (
        <span className={`dsh-hub-update-state${status.danger ? ' dsh-hub-note-danger' : ''}`} role="status">{status.text}</span>
      )}
      {error === null ? null : <span className="dsh-hub-update-state dsh-hub-note-danger" role="alert">{error}</span>}
      <button
        type="button"
        className={`dsh-hub-update-button${busy ? ' dsh-hub-update-busy' : ''}`}
        aria-label={label}
        title={label}
        disabled={busy}
        onClick={() => { void (canOfferApply ? runApply() : runCheck()) }}
      >
        <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: REFRESH_SVG }} />
        {canOfferApply ? <span className="dsh-hub-update-dot" aria-hidden="true" /> : null}
      </button>
    </div>
    {showCommand ? <code className="dsh-hub-update-command" aria-label={t('hubUpdateCommandLabel')}>{check.command}</code> : null}
  </div>
}
