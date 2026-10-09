/**
 * The WorkBuddy subscription settings card.
 *
 * Markup only: every piece of state, every effect and every request this card
 * makes lives in 'useWorkBuddySection.ts', which returns one named shape the JSX
 * below reads. The two files are the split of a single 885-line component — the
 * behaviour is unchanged, and this one should stay render-shaped.
 */
import React from 'react'
import type {
  WorkBuddyAccountSummaryDto,
  WorkBuddyModelCredits,
  WorkBuddyModelOption,
  WorkBuddyReasoningEffort,
  WorkBuddyRegion,
} from '../../shared/workbuddy-contracts.ts'
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import { ContextWindowEditor } from '../common/ContextWindowEditor.tsx'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import { formatCapacity, formatDate, formatReset } from '../common/format.ts'
import { useWorkBuddySection, type WorkBuddySectionProps } from './useWorkBuddySection.ts'
import { zh } from './locales.ts'

/**
 * Display label per reasoning level. The locale dictionary only accepts flat
 * string values, so this nested table lives with the control that renders it.
 */
const EFFORT_LABELS: Record<WorkBuddyReasoningEffort, string> = {
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

export function WorkBuddySection({ onModelChange, loadModelDirectory }: WorkBuddySectionProps): React.ReactElement {
  const { state, derived, actions } = useWorkBuddySection({ onModelChange, loadModelDirectory })
  const { status, loading, busy, error, connection, loginProgress, contextDrafts, savingModel } = state
  const {
    poolAccounts, effortChoices, allModels, strayEffort, contextModels, overrideCount,
    quota, authenticated, unreachable, poolLabels,
  } = derived
  const {
    login, rescan, accountAction, deleteAccount, setStrategy, testConnection, refreshQuota,
    checkinNow, updateCheckin, toggleModel, setAllModels, updateEffort, refreshCatalog,
    saveContextWindow, resetContextWindow, resetAllContextWindows, updateContextDraft,
  } = actions

  const t = zh

  if (loading) {
    return (
      <div className="dsha-page">
        <div className="dsha-empty">{t.loading}</div>
      </div>
    )
  }

  return (
    <div className="dsha-page">
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
        renderDetails={(candidate) => (
          <>
            {candidate.uin ? <span>{t.uin}: {maskUin(candidate.uin)}</span> : null}
            {candidate.accountType ? <span>{t.accountType}: {candidate.accountType}</span> : null}
            <span>
              {t.region}: {candidate.region === 'intl' ? t.regionIntl : t.regionCn}
            </span>
            {candidate.domain ? (
              <span className="dshwb-mono" title={`${candidate.domain} · ${candidate.backend ?? ''}`}>
                {candidate.domain}
              </span>
            ) : null}
            {candidate.hidden === true ? <span>{t.hiddenAccount}</span> : null}
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
