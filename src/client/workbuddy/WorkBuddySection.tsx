/**
 * The WorkBuddy subscription settings card.
 *
 * Markup only: every piece of state, every effect and every request this card
 * makes lives in 'useWorkBuddySection.ts', which returns one named shape the JSX
 * below reads. The two files are the split of a single 885-line component — the
 * behaviour is unchanged, and this one should stay render-shaped.
 *
 * Three line-private facts are drawn here rather than taught to a shared
 * component, because none of them belongs to any other line:
 *
 *   - the whole-pool pause. A pause is a decision about the POOL — nothing is
 *     routable — and no per-account field can express it, so it is stated before
 *     the account list and never softened into "3 accounts available";
 *   - the per-model park. The upstream refuses one MODEL (429) while the account
 *     keeps serving the rest, so the row names the model and when it lifts;
 *   - the account-scoped restriction, which bars the account itself.
 */
import React, { useEffect, useState } from 'react'
import type { PoolStorageDto } from '../../shared/contracts.ts'
import type {
  WorkBuddyAccountRestrictionDto,
  WorkBuddyAccountSummaryDto,
  WorkBuddyPoolStateDto,
  WorkBuddyModelCredits,
  WorkBuddyModelOption,
  WorkBuddyOutboundSetting,
  WorkBuddyReasoningEffort,
  WorkBuddyRegion,
} from '../../shared/workbuddy-contracts.ts'
import { liveWorkBuddyModelCooldowns } from '../../shared/workbuddy-contracts.ts'
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import { AccountQuota } from '../common/account-quota.tsx'
import { formatPoolLabel } from '../common/account-pool-labels.ts'
import { ContextWindowEditor } from '../common/ContextWindowEditor.tsx'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import { formatCapacity, formatDate, formatReset } from '../common/format.ts'
import { useLineDict } from '../common/line-locale.ts'
import { useWorkBuddySection, type WorkBuddySectionProps } from './useWorkBuddySection.ts'
import { NS_WORKBUDDY, zh } from './locales.ts'

/**
 * Display label per reasoning level. The locale dictionary only accepts flat
 * string values, so this nested table lives with the control that renders it.
 */
const EFFORT_LABELS: Record<WorkBuddyReasoningEffort, string> = {
  // Not a rung of any ladder: the measured spelling that switches the trace off
  // on the models whose catalog entry allows it.
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
}

/**
 * The consumption rate of one model, as the settings row states it.
 *
 * The gateway publishes one rate per region and the official CodeBuddy picker
 * spells it beside a model as `6.67x`; the row uses the same shape behind the
 * section's own label. Which rates reach the row depends on what the card knows
 * about the account, and the two cases are deliberately different:
 *
 * - A KNOWN region shows that region's rate and nothing else. Borrowing the
 *   sibling region's number would state a price this account never pays —
 *   measured 2026-10-09, `deepseek-v4.1-flash` is `0.11` on cn against `0.00`
 *   on intl, and the backends reject a model asked of the wrong region anyway.
 * - An UNKNOWN region (no account read back yet) shows both rates when the
 *   backends disagree, so the row is honest about the range instead of picking
 *   one of them. When they agree there is nothing to disambiguate.
 *
 * The two-region form is assembled entirely from the caller's labels: the
 * qualifier comes from `labels.region(value, key)` and the join from
 * `labels.pair(first, second)`, so the dictionary owns the region nouns, the
 * bracket glyphs AND the separator. Nothing about the two-region string is
 * spelled in this file, which is the point — the glyphs differ per language
 * (`倍率 0.11x（国区） / 0.00x（国际区）` in Chinese,
 * `Multiplier 0.11x (China) / 0.00x (International)` in English) and a
 * separator chosen here would be right in at most one of them.
 *
 * `null` means "this row states no rate"; the caller drops it from the hint
 * array rather than rendering a placeholder, because a guessed rate on a spend
 * figure is worse than a missing one. `'0.00'` is a declaration — this model
 * consumes no allowance — so it renders like any other value.
 */
export function creditMultiplierHint(
  credits: WorkBuddyModelCredits | undefined,
  region: WorkBuddyRegion | null,
  labels: {
    multiplier: string
    region: (value: string, key: WorkBuddyRegion) => string
    pair: (first: string, second: string) => string
  },
): string | null {
  // An empty string is the shape a catalog entry takes when its publisher
  // declared no rate: the host's parser already turns it into an absent key,
  // and a client running against a host that did not must not print `倍率 x`.
  const rate = (key: WorkBuddyRegion): string | null => {
    const value = credits?.[key]
    return typeof value === 'string' && value !== '' ? value : null
  }

  if (region !== null) {
    const value = rate(region)
    return value === null ? null : `${labels.multiplier} ${value}x`
  }

  const cn = rate('cn')
  const intl = rate('intl')
  if (cn === null) return intl === null ? null : `${labels.multiplier} ${intl}x`
  if (intl === null || intl === cn) return `${labels.multiplier} ${cn}x`
  // Both regions, cn first, each qualified: an unqualified pair would read as
  // one rate with a stray number beside it. The join comes from `labels.pair`
  // too — a separator written here would be the one piece of this string the
  // dictionary could not reach, and it is exactly where the two languages
  // diverge (a full-width bracket already carries its own spacing, an ASCII one
  // does not, so `(China)/ 0.00x` glued the entries together).
  return `${labels.multiplier} ${labels.pair(
    labels.region(`${cn}x`, 'cn'),
    labels.region(`${intl}x`, 'intl'),
  )}`
}

/** Mask a UIN so the card shows identity without publishing the full number. */
export function maskUin(uin?: string | null): string {
  if (uin === undefined || uin === null || uin === '') return '—'
  if (uin.length <= 6) return uin
  return `${uin.slice(0, 4)}****${uin.slice(-2)}`
}

/** The subset of the card's words a pool-state sentence needs. */
export type PoolStateLabels = Pick<
  typeof zh,
  | 'poolState'
  | 'poolPaused'
  | 'poolPausedReason'
  | 'poolPausedUntil'
  | 'poolPausedManual'
  | 'poolRestrictedCount'
  | 'poolStorageLabel'
  | 'poolStorageEncrypted'
  | 'poolStoragePlain'
  | 'poolStorageBackendKeyring'
  | 'poolStorageBackendCredentials'
  | 'poolStorageBackendDpapi'
  | 'poolStorageBackendKeychain'
  | 'poolStorageUnavailableKeyring'
  | 'poolStorageUnavailableCredentials'
  | 'poolStorageUnavailableStore'
>

/**
 * The store that actually holds the pool document, in the reader's words.
 *
 * One label per BACKEND and not per configured value: `keyring` resolves to DPAPI
 * on Windows, the Keychain on macOS and the Secret Service on Linux, so a reader
 * looking at an unreadable pool needs to know which store answered. Every branch
 * is spelled out, so a new backend cannot reach the card as a raw fallback.
 */
export function poolStorageBackendLabel(storage: PoolStorageDto, t: PoolStateLabels): string {
  switch (storage.backend) {
    case 'keyring': return t.poolStorageBackendKeyring
    case 'credentials': return t.poolStorageBackendCredentials
    case 'dpapi': return t.poolStorageBackendDpapi
    case 'keychain': return t.poolStorageBackendKeychain
  }
}

/** Why the configured store is not usable here, in the reader's language. */
export function poolStorageUnavailableLabel(storage: PoolStorageDto, t: PoolStateLabels): string | null {
  switch (storage.unavailable) {
    case undefined: return null
    case 'keyring-unreachable': return t.poolStorageUnavailableKeyring
    case 'no-credentials-service': return t.poolStorageUnavailableCredentials
    case 'store-unreadable': return t.poolStorageUnavailableStore
  }
}

/** The one-line storage description, or null when the host reports no pool store. */
export function poolStorageLine(storage: PoolStorageDto | undefined, t: PoolStateLabels): string | null {
  if (storage === undefined) return null
  const state = storage.encrypted ? t.poolStorageEncrypted : t.poolStoragePlain
  return `${t.poolStorageLabel}: ${poolStorageBackendLabel(storage, t)} · ${state}`
}

/**
 * The sentences the whole-pool banner states, in order of importance.
 *
 * Exported because it is the rule this card exists to get right: a paused pool
 * has to reach the screen as "nothing is routable", never as a healthy account
 * count. `now` is a parameter so one render walks one instant.
 */
export function poolStateLines(
  pool: WorkBuddyPoolStateDto | undefined,
  t: PoolStateLabels,
  now: number,
): { paused: boolean; restrictedCount: number; lines: string[] } {
  if (pool === undefined) return { paused: false, restrictedCount: 0, lines: [] }
  const restrictedCount = (pool.restrictedAccountIds ?? []).length
  const lines: string[] = []
  if (pool.paused === true) {
    lines.push(t.poolPaused)
    if (pool.pauseReason !== undefined && pool.pauseReason !== '') {
      lines.push(formatPoolLabel(t.poolPausedReason, { reason: pool.pauseReason }))
    }
    // A pause that lifts on its own says when; one that does not says so,
    // because "paused" with no horizon reads as a stuck card.
    const remaining = formatReset(pool.pausedUntil)
    lines.push(remaining === '' ? t.poolPausedManual : formatPoolLabel(t.poolPausedUntil, { time: remaining }))
  }
  if (restrictedCount > 0) lines.push(formatPoolLabel(t.poolRestrictedCount, { count: restrictedCount }))
  return { paused: pool.paused === true, restrictedCount, lines: lines.filter((line) => line !== '') }
}

/** The account-scoped refusal, as one sentence plus when it lifts. */
export function restrictionLines(
  restriction: WorkBuddyAccountRestrictionDto | undefined,
  t: Pick<typeof zh, 'restrictedAccount' | 'liftsIn' | 'restrictedAccountMessage'>,
): string[] {
  if (restriction === undefined) return []
  const lines = [`${t.restrictedAccount} (${restriction.code})`]
  const remaining = formatReset(restriction.until)
  if (remaining !== '') lines.push(formatPoolLabel(t.liftsIn, { time: remaining }))
  if (restriction.message !== undefined && restriction.message !== '') {
    lines.push(formatPoolLabel(t.restrictedAccountMessage, { message: restriction.message }))
  }
  return lines
}

export function WorkBuddySection({ onModelChange, loadModelDirectory }: WorkBuddySectionProps): React.ReactElement {
  const { state, derived, actions } = useWorkBuddySection({ onModelChange, loadModelDirectory })
  const { status, loading, busy, error, connection, loginProgress, contextDrafts, savingModel } = state
  const {
    poolAccounts, effortChoices, allModels, strayEffort, contextModels, overrideCount,
    quota, authenticated, unreachable, poolLabels,
  } = derived
  const sealedCount = status?.sealedAccounts ?? 0
  const {
    login, rescan, accountAction, deleteAccount, setStrategy, testConnection, refreshQuota,
    checkinNow, updateCheckin, toggleModel, setAllModels, updateEffort, refreshCatalog,
    saveContextWindow, resetContextWindow, resetAllContextWindows, updateContextDraft,
    updateOutboundIdentity, saveAtRestKey, clearAtRestKey, updateGuardrails,
  } = actions

  // The pasted secret never leaves this component except through the one POST
  // that stores it; it is not mirrored into the hook's state.
  const [keyDraft, setKeyDraft] = useState('')
  // Guardrail fields are edited as drafts and committed on blur: a number input
  // fires on every keystroke, and each commit is a round trip.
  const [guardrailDrafts, setGuardrailDrafts] = useState<Record<string, string>>({})

  const pool = status?.pool
  const pausedUntil = pool?.pausedUntil
  // A pause that lifts on its own is a countdown, so it has to tick: a number
  // frozen at render time would show the same "in 5 minutes" for five minutes.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (pausedUntil === undefined) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pausedUntil])

  const t = useLineDict(NS_WORKBUDDY, zh)
  const poolState = poolStateLines(pool, t, now)
  const storageLine = poolStorageLine(pool?.storage, t)
  const storageUnavailable = pool?.storage === undefined ? null : poolStorageUnavailableLabel(pool.storage, t)
  const restrictedIds = pool?.restrictedAccountIds ?? []

  if (loading) {
    return (
      <div className="dsha-page">
        <div className="dsha-empty">{t.loading}</div>
      </div>
    )
  }

  return (
    <div className="dsha-page">
      {/* Stated BEFORE the account list. A paused pool has no routable account,
          and green cards under this banner would read as availability whatever
          the sentence above them says. */}
      {pool !== undefined && (poolState.lines.length > 0 || storageLine !== null) ? (
        <div className={`dsh-wb-pool${poolState.paused ? ' dsh-wb-pool--paused' : ''}`} data-paused={poolState.paused}>
          <div className="dsh-wb-pool-title">{poolState.paused ? t.poolPaused : t.poolState}</div>
          {poolState.lines.filter((line) => line !== t.poolPaused).map((line) => (
            <div key={line} className="dsh-wb-pool-body">{line}</div>
          ))}
          {storageLine !== null ? <div className="dsh-wb-pool-meta">{storageLine}</div> : null}
          {storageUnavailable !== null ? <div className="dsh-wb-pool-meta">{storageUnavailable}</div> : null}
        </div>
      ) : null}

      <AccountPoolSection<WorkBuddyAccountSummaryDto>
        accounts={poolAccounts}
        activeAccountId={status?.activeAccountId}
        rotationStrategy={status?.rotationStrategy ?? 'sequential'}
        labels={poolLabels}
        busy={busy}
        showQuota
        onLogin={() => void login('cn')}
        onSetPrimary={(id) => void accountAction('set-primary', id)}
        onDelete={(id) => void deleteAccount(id)}
        onClearCooldown={(id) => void accountAction('clear-cooldown', id)}
        onRelogin={(id) => void accountAction('relogin', id)}
        onSetStrategy={(strategy) => void setStrategy(strategy)}
        renderLoginActions={() => (
          <div className="dsha-account-add-actions">
            <button className="dsha-btn dsha-btn-primary" disabled={busy !== null} onClick={() => void login('cn')}>
              {busy === 'login:cn' ? t.authorizing : t.addCnAccount}
            </button>
            <button className="dsha-btn dsha-btn-primary" disabled={busy !== null} onClick={() => void login('intl')}>
              {busy === 'login:intl' ? t.authorizing : t.addIntlAccount}
            </button>
          </div>
        )}
        renderAccountActions={(candidate) => (
          // Only an account this plugin owns may be deleted; a desktop account
          // is the IDE's, so the card offers hide/restore for it instead.
          candidate.removable ? null : (
            <>
              {candidate.hidden === true && (
                <button className="dsha-btn" disabled={busy !== null} onClick={() => void accountAction('restore', candidate.id)}>
                  {t.restoreAccount}
                </button>
              )}
              {candidate.hidden !== true && (
                <button className="dsha-btn" disabled={busy !== null} onClick={() => void accountAction('hide', candidate.id)}>
                  {t.hideAccount}
                </button>
              )}
            </>
          )
        )}
        renderDetails={(candidate) => {
          const restricted = restrictedIds.includes(candidate.id) || candidate.restriction !== undefined
          const notRoutable = poolState.paused || restricted || candidate.hidden === true
          return (
            <>
              {candidate.uin ? <span>{t.uin}: {maskUin(candidate.uin)}</span> : null}
              {candidate.accountType ? <span>{t.accountType}: {candidate.accountType}</span> : null}
              <span>
                {t.region}: {candidate.region === 'intl' ? t.regionIntl : t.regionCn}
              </span>
              {candidate.domain ? (
                <span className="dsh-wb-mono" title={`${candidate.domain} · ${candidate.backend ?? ''}`}>
                  {candidate.domain}
                </span>
              ) : null}
              {candidate.hidden === true ? <span>{t.hiddenAccount}</span> : null}
              {/* The pool's own facts, per account. Without these a paused pool
                  or a barred account would still render as an ordinary card. */}
              {notRoutable ? <span className="dsh-wb-flag">{t.notRoutable}</span> : null}
              {restrictionLines(candidate.restriction, t).map((line) => (
                <span key={line} className="dsh-wb-flag">{line}</span>
              ))}
            </>
          )
        }}
        renderQuota={(candidate, _index, clock) => (
          <>
            <AccountQuota quota={candidate.quota} labels={poolLabels} showEmpty now={clock} />
            {/* A park that already lifted is dropped rather than listed: naming
                an expired park tells the user an eligible model is unavailable. */}
            {liveWorkBuddyModelCooldowns(candidate.modelCooldowns, clock).length > 0 ? (
              <div className="dsh-wb-parks">
                <span className="dsh-wb-flag dsh-wb-flag--park">{t.modelCooldown}</span>
                {liveWorkBuddyModelCooldowns(candidate.modelCooldowns, clock).map((park) => (
                  <span key={`${park.model}:${park.cooldownUntil}`} className="dsh-wb-park">
                    {`${park.model} · ${formatPoolLabel(t.liftsIn, { time: formatReset(park.cooldownUntil) })}`}
                  </span>
                ))}
              </div>
            ) : null}
          </>
        )}
      >
        {/* The shared empty state already covers "no account signed in"; only
            an unreachable route needs a panel of its own, because it must not
            read as a credential problem. */}
        {unreachable ? (
          <>
            <div className="dsha-empty">{t.routeUnreachable}</div>
            <p className="dsha-notice">{t.routeUnreachableHint}</p>
          </>
        ) : null}
        {loginProgress ? <p className="dsha-notice">{loginProgress}</p> : null}
        <div className="dsha-actions">
          <button className="dsha-btn" disabled={busy !== null} onClick={() => void rescan()}>
            {busy === 'rescan' ? t.rescanning : t.rescan}
          </button>
        </div>
      </AccountPoolSection>

      {/* No new `h3` here: the card's heading order is pinned by a test and by
          the shared settings-page layout, so these two controls join the card as
          sub-blocks rather than becoming panels of their own. */}
      <section className="dsha-group">
        <p className="dsha-label" style={{ fontWeight: 600 }}>{t.outboundSection}</p>
        <p className="dsha-muted">{t.outboundHint}</p>
        <div style={{ margin: '10px 0 14px' }}>
          <select
            className="dsha-select"
            value={status?.outboundIdentity ?? 'cli'}
            disabled={busy !== null}
            onChange={(event) => void updateOutboundIdentity(event.currentTarget.value as WorkBuddyOutboundSetting)}
          >
            <option value="cli">{t.outboundCli}</option>
            <option value="auto">{t.outboundAuto}</option>
            <option value="workbuddy">{t.outboundWorkbuddy}</option>
            <option value="vscode">{t.outboundVscode}</option>
          </select>
        </div>

        <p className="dsha-label" style={{ fontWeight: 600, marginTop: 12 }}>{t.guardrailsSection}</p>
        <p className="dsha-muted">{t.guardrailsHint}</p>
        <div className="dsh-wb-fields">
          {([
            ['reserveCredits', t.guardrailsReserve],
            ['dailyTokens', t.guardrailsDaily],
            ['modelDailyTokens', t.guardrailsModelDaily],
          ] as const).map(([field, label]) => (
            <label key={field} className="dsh-wb-field">
              <span>{label}</span>
              <span className="dsh-wb-control">
                <input
                  type="number"
                  min={0}
                  step={1}
                  disabled={busy !== null}
                  value={guardrailDrafts[field] ?? String(status?.guardrails?.[field] ?? 0)}
                  onChange={(event) => {
                    // React clears currentTarget after the event callback, before
                    // a deferred state updater may run.
                    const draft = event.currentTarget.value
                    setGuardrailDrafts((prev) => ({ ...prev, [field]: draft }))
                  }}
                  onBlur={() => {
                    const draft = guardrailDrafts[field]
                    if (draft === undefined) return
                    setGuardrailDrafts((prev) => {
                      const next = { ...prev }
                      delete next[field]
                      return next
                    })
                    const value = Math.floor(Number(draft))
                    if (!Number.isFinite(value) || value < 0) return
                    void updateGuardrails({ [field]: value })
                  }}
                />
                <small>{field === 'reserveCredits' ? t.credits : 'tokens'}</small>
              </span>
            </label>
          ))}
        </div>

        <p className="dsha-label" style={{ fontWeight: 600, marginTop: 12 }}>{t.atRestSection}</p>
        <p className="dsha-muted">{t.atRestHint}</p>
        {sealedCount > 0 ? (
          <p className="dsha-notice">{t.atRestSealed.replace('{count}', String(sealedCount))}</p>
        ) : null}
        <div className="dsh-wb-inputrow">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t.atRestPlaceholder}
            value={keyDraft}
            disabled={busy !== null}
            onChange={(event) => setKeyDraft(event.currentTarget.value)}
          />
          <button
            className="dsha-btn dsha-btn-primary"
            disabled={busy !== null || keyDraft.trim() === ''}
            onClick={() => {
              void saveAtRestKey(keyDraft.trim()).then(() => setKeyDraft(''))
            }}
          >
            {busy === 'atrest' ? t.saving : t.atRestSave}
          </button>
          {status?.atRestKeySet === true ? (
            <>
              <span className="dsha-muted">{t.atRestSaved}</span>
              <button className="dsha-btn" disabled={busy !== null} onClick={() => void clearAtRestKey()}>
                {t.atRestClear}
              </button>
            </>
          ) : null}
        </div>
      </section>

      {status?.checkin != null ? (
        <section className="dsha-group">
          <div className="dsha-grouphead">
            <h3>{t.dailyCheckin}</h3>
          </div>
          <p className="dsha-muted">{t.checkinHint}</p>
          <div className="dsha-row" style={{ marginBottom: 8 }}>
            <span className="dsha-label" style={{ fontWeight: 600 }}>{t.checkinAuto}</span>
            <input
              type="checkbox"
              checked={status.checkin.enabled}
              disabled={busy !== null}
              onChange={(event) => void updateCheckin({ enabled: event.currentTarget.checked })}
            />
          </div>
          <div className="dsha-row">
            <span className="dsha-label">{t.dailyCheckin}</span>
            <span className="dsha-value">
              {t.checkinToday.replace('{done}', String(status.checkin.doneToday)).replace('{total}', String(status.checkin.totalAccounts))}
              {status.checkin.skippedToday > 0
                ? ` · ${t.checkinSkipped.replace('{count}', String(status.checkin.skippedToday))}`
                : ''}
              {status.checkin.failedToday > 0
                ? ` · ${t.checkinFailed.replace('{count}', String(status.checkin.failedToday))}`
                : ''}
              {` · ${status.checkin.lastRunAt === null ? t.checkinNever : t.checkinLastRun.replace('{time}', new Date(status.checkin.lastRunAt).toLocaleString())}`}
            </span>
          </div>
          <div className="dsha-actions">
            <button className="dsha-btn" disabled={busy !== null} onClick={() => void checkinNow()}>
              {busy === 'checkin' ? t.checkinRunning : t.checkinNow}
            </button>
          </div>
        </section>
      ) : null}

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.connection}</h3>
        </div>
        <p className="dsha-notice">
          {status?.serving === false && status.conflict
            ? t.routeConflict.replace('{detail}', status.conflict)
            : t.routeOwned}
        </p>
        <div className="dsha-actions">
          <button
            className="dsha-btn"
            disabled={busy !== null || !authenticated}
            onClick={() => void testConnection()}
          >
            {busy === 'connection' ? t.testingConnection : t.testConnection}
          </button>
        </div>
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.modelsSection}</h3>
          <button
            className="dsha-btn"
            disabled={busy !== null || !authenticated}
            onClick={() => void refreshCatalog()}
          >
            {busy === 'catalog' ? t.refreshingCatalog : t.refreshCatalog}
          </button>
        </div>
        <p className="dsha-muted dsha-models-hint">{t.modelsHint}</p>
        <ModelChecklist
          items={(status?.models ?? []).map((model: WorkBuddyModelOption) => {
            // The spend rate goes LAST: capacity and the image/effort facts
            // describe what the model accepts, while the multiplier describes
            // what it costs. Keeping the money fact at the end leaves the
            // capability cluster readable as one phrase, and it reads the same
            // way the official picker spells a rate beside a model.
            const multiplier = creditMultiplierHint(model.credits, status?.account?.region ?? null, {
              multiplier: t.creditMultiplier,
              region: (value: string, key: WorkBuddyRegion): string => t.creditMultiplierRegion
                .replace('{value}', value)
                .replace('{region}', key === 'cn' ? t.regionCn : t.regionIntl),
              pair: (first: string, second: string): string => t.creditMultiplierPair
                .replace('{first}', first)
                .replace('{second}', second),
            })
            return {
              id: model.id,
              name: model.name,
              hint: [
                formatCapacity(model.contextWindow),
                model.supportsImage ? t.imageSupport : t.textOnly,
                ...(model.reasoningEfforts && model.reasoningEfforts.length > 0
                  ? [model.reasoningEfforts.join('/')]
                  : []),
                // A model with no published rate contributes NO element, so the
                // line neither grows a placeholder nor gains a doubled separator.
                ...(multiplier === null ? [] : [multiplier]),
              ].join(' · '),
              enabled: model.enabled,
            }
          })}
          busy={busy !== null}
          onToggle={(id, enabled) => void toggleModel(id, enabled)}
          onToggleAll={(enabled) => void setAllModels(enabled)}
          labels={{ selectAll: t.selectAll, clearAll: t.unselectAll, list: t.modelsSection }}
        />
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.enhanced}</h3>
        </div>
        <div className="dsha-pref-row">
          <div>
            <strong>{t.defaultReasoningEffort}</strong>
            <p className="dsha-muted">{t.defaultReasoningEffortHint}</p>
            {strayEffort !== null ? <p className="dsha-muted">{t.defaultEffortKept}</p> : null}
          </div>
          <select
            className="dsha-select"
            aria-label={t.defaultReasoningEffort}
            value={status?.defaultReasoningEffort ?? ''}
            disabled={busy !== null}
            onChange={(event) => {
              const value = event.currentTarget.value
              void updateEffort(value === '' ? null : (value as WorkBuddyReasoningEffort))
            }}
          >
            <option value="">{t.defaultEffortAuto}</option>
            {/* A saved level no model declares is kept selectable so opening
                the card does not silently rewrite the stored value. */}
            {strayEffort !== null ? (
              <option value={strayEffort}>{`${EFFORT_LABELS[strayEffort]} (${t.effortUnsupported})`}</option>
            ) : null}
            {effortChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.models.length === allModels.length
                  ? EFFORT_LABELS[choice.value]
                  : `${EFFORT_LABELS[choice.value]} (${choice.models.length}/${allModels.length})`}
              </option>
            ))}
          </select>
        </div>
        {effortChoices.length === 0 ? (
          <p className="dsha-muted">{t.noReasoningModels}</p>
        ) : null}
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.contextWindowSection}</h3>
        </div>
        <p className="dsha-muted">{t.contextWindowHint}</p>
        <ContextWindowEditor
          rows={contextModels.map((model: WorkBuddyModelOption) => ({
            id: model.id,
            name: model.name,
            draft: contextDrafts[model.id] ?? '',
            inputLabel: `${model.name} context window`,
            hasOverride: status?.contextWindowOverrides[model.id] !== undefined,
            saving: savingModel === model.id,
          }))}
          labels={{
            tokens: 'tokens',
            save: t.save,
            saving: t.saving,
            reset: t.contextWindowReset,
            resetAll: t.contextWindowResetAll,
            empty: t.contextWindowNoneEnabled,
          }}
          busy={busy !== null}
          overrideCount={overrideCount}
          onDraftChange={(id, draft) => updateContextDraft(id, draft)}
          onCommit={(id) => void saveContextWindow(id)}
          onReset={(id) => void resetContextWindow(id)}
          onResetAll={() => void resetAllContextWindows()}
        />
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.quotaSection}</h3>
          <button
            className="dsha-btn"
            disabled={busy !== null || !authenticated}
            onClick={() => void refreshQuota()}
          >
            {busy === 'quota' ? t.refreshingQuota : t.refreshQuota}
          </button>
        </div>
        <p className="dsha-muted">{t.quotaDesc}</p>
        {/* The progress bars moved into each account card: quota follows the
            account, so a bar here could only ever describe whichever account
            happened to be active when the snapshot was read. What stays is what
            has no per-account bar to live in — the package and its credits, the
            cycle counters, the meters that state no share, and the freshness of
            this reading. */}
        <p className="dsha-muted">{poolLabels.quotaFactsScope}</p>

        {!authenticated ? (
          <div className="dsha-empty">{t.signedOut}</div>
        ) : quota === null || quota === undefined ? (
          <div className="dsha-empty">{busy === 'quota' ? t.refreshingQuota : t.quotaEmpty}</div>
        ) : (
          <div className="dsha-quota-card">
            <div className="dsha-quota-title">
              <strong>{quota.packageName || t.quotaPackage}</strong>
              <span>
                {quota.remainingCredits !== null
                  ? `${quota.remainingCredits} ${t.credits}`
                  : '—'}
              </span>
            </div>

            {quota.cycleUsedCredits !== null && (
              <div className="dsha-row">
                <span className="dsha-label">{t.quotaCycle}</span>
                <span className="dsha-value">
                  {quota.cycleUsedCredits}
                  {quota.cycleCredits !== null ? ` / ${quota.cycleCredits}` : ''}
                  {` ${t.credits}`}
                </span>
              </div>
            )}
            {quota.cycleEndsAt !== null && (
              <div className="dsha-row">
                <span className="dsha-label">{t.quotaReset}</span>
                <span className="dsha-value">
                  {formatDate(quota.cycleEndsAt)}
                  {formatReset(quota.cycleEndsAt) ? ` · ${formatReset(quota.cycleEndsAt)}` : ''}
                </span>
              </div>
            )}

            {quota.meters.filter((meter) => meter.remainingFraction === null).map((meter) => (
              <div key={meter.id} className="dsha-meter-wrap">
                <div className="dsha-meter-label">
                  <span>{meter.label}</span>
                  <strong>{meter.limit ?? '—'}</strong>
                </div>
                <div className="dsha-meter-meta">
                  {meter.used !== null && <span>{meter.used} / {meter.limit ?? '—'}</span>}
                  {meter.resetsAt !== null && <span>{t.quotaReset}: {formatReset(meter.resetsAt)}</span>}
                </div>
                {meter.description !== null && (
                  <div className="dsha-meter-meta"><span>{meter.description}</span></div>
                )}
              </div>
            ))}

            {quota.meters.length === 0 && <div className="dsha-empty">{t.quotaEmpty}</div>}

            <div className="dsha-timestamp">
              {t.updatedAt.replace('{time}', new Date(quota.fetchedAt).toLocaleString())}
            </div>
          </div>
        )}
      </section>

      {error && (
        <div className="dsha-error">
          <div>{error}</div>
        </div>
      )}
    </div>
  )
}
