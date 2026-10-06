/**
 * The Claude subscription settings card.
 *
 * Markup only: every piece of state, every effect and every request this card
 * makes lives in 'useClaudeSection.ts', which returns one named shape the JSX
 * below reads. The two files are the split of a single 900-line component — the
 * behaviour is unchanged, and this one should stay render-shaped.
 */
import React from 'react'
import type {
  ClaudeAccountSummaryDto,
  ClaudeCacheTtl,
  ClaudeModelOption,
  ClaudeReasoningEffort,
} from '../../shared/claude-contracts.ts'
import { CLAUDE_REASONING_EFFORTS } from '../../shared/claude-contracts.ts'
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import { ContextWindowEditor } from '../common/ContextWindowEditor.tsx'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import { formatCapacity, formatDate } from '../common/format.ts'
import { useClaudeSection, type ClaudeSectionProps } from './useClaudeSection.ts'
import { zh } from './locales.ts'

/**
 * Display label per thinking level.
 *
 * The locale dictionary only accepts flat string values, so this table lives
 * with the control that renders it — the same arrangement every sibling uses.
 * Every level the wire can name is listed, 'xhigh' included: filtering a level
 * out here would hide a choice the host would accept and a catalog may expose.
 */
const EFFORT_LABELS: Record<ClaudeReasoningEffort, string> = {
  low: zh.effortLow,
  medium: zh.effortMedium,
  high: zh.effortHigh,
  xhigh: zh.effortXHigh,
  max: zh.effortMax,
}

/** One-line capability summary shown as a model pill's hover title. */
function modelFacts(model: ClaudeModelOption, t: typeof zh): string[] {
  const thinking = model.thinkingMode === 'mid-convo'
    ? t.thinkingModeMidConvo
    : model.thinkingMode === 'adaptive'
      ? t.thinkingModeAdaptive
      : model.thinkingMode === 'budget' ? t.thinkingModeBudget : t.thinkingModeNone
  return [
    model.id,
    model.supportsImage ? t.capImage : t.capNoImage,
    thinking,
    ...(model.canDisableThinking ? [t.capThinkingOff] : []),
    ...(model.reasoningEfforts.length > 0 ? [model.reasoningEfforts.join('/')] : []),
  ]
}

export function ClaudeSection({ onModelChange, loadModelDirectory }: ClaudeSectionProps): React.ReactElement {
  const { state, derived, actions } = useClaudeSection({ onModelChange, loadModelDirectory })
  const { status, loading, busy, error, flow, connection, pasteValue, contextDrafts, savingModel } = state
  const { accounts, hasAdopted, contextModels, overrideCount, quota, windows, poolLabels } = derived
  const {
    login, cancelLogin, submitPaste, adopt, stopImporting, accountAction, setStrategy, relogin,
    refreshQuota, refreshCatalog, testConnection, toggleModel, setAllModels, updateEffort,
    updateCacheTtl, saveContextWindow, resetContextWindow, resetAllContextWindows,
    updateContextDraft, setPasteValue,
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
      <AccountPoolSection<ClaudeAccountSummaryDto>
        accounts={accounts}
        activeAccountId={status?.activeAccountId}
        rotationStrategy={status?.rotationStrategy ?? 'sequential'}
        busy={busy}
        labels={poolLabels}
        onLogin={() => void login()}
        onSetPrimary={(accountId) => void accountAction('set-primary', accountId)}
        onDelete={(accountId) => void accountAction('delete', accountId)}
        onClearCooldown={(accountId) => void accountAction('clear-cooldown', accountId)}
        onRelogin={(accountId) => relogin(accountId)}
        onSetStrategy={(strategy) => void setStrategy(strategy)}
        showQuota
        renderLoginActions={() => (
          <div className="dsha-account-add-actions">
            <button
              className="dsha-btn dsha-btn-primary"
              disabled={busy !== null}
              aria-label={t.signIn}
              onClick={() => void login()}
            >
              {busy === 'login' ? t.signingIn : t.signIn}
            </button>
            {/* The second entry: an existing local Claude Code sign-in can be
                borrowed instead of running a fresh OAuth flow. */}
            <button
              className="dsha-btn"
              disabled={busy !== null}
              aria-label={t.importClaudeCode}
              onClick={() => void adopt()}
            >
              {busy === 'adopt' ? t.importing : t.importClaudeCode}
            </button>
          </div>
        )}
        renderAccountActions={(entry) => (
          // An imported row is a snapshot of a sign-in this plugin does NOT own,
          // so the shared card suppresses Delete for it ('removable: false') and
          // this is the action that replaces it. Un-importing forgets the
          // snapshot; Claude Code's own file is never touched.
          entry.adopted === true || entry.removable === false ? (
            <button
              className="dsha-btn"
              disabled={busy !== null}
              aria-label={`${t.stopImporting}: ${entry.id}`}
              onClick={() => void stopImporting(entry.id)}
            >
              {busy === `adopt-disable-${entry.id}` ? t.importing : t.stopImporting}
            </button>
          ) : null
        )}
        // Only facts the shared card cannot know. E-mail is the shared card's
        // row (and is usually the card's title already); the snapshot path is
        // credential bookkeeping, which the card does not show anywhere.
        renderDetails={(entry) => (
          <>
            {entry.planLabel && <span>{t.plan}: {entry.planLabel}</span>}
            {entry.subscriptionType && <span>{t.subscriptionType}: {entry.subscriptionType}</span>}
            <span>
              {t.source}: {entry.source === 'claude-code' ? t.sourceClaudeCode : t.sourceManaged}
            </span>
          </>
        )}
      >
        <p className="dsha-muted" style={{ paddingTop: 12 }}>{t.importHint}</p>
        <p className="dsha-muted">
          {status?.claudeCodeSignInAvailable === true ? t.importClaudeCode : t.importUnavailable}
        </p>
        {status?.claudeCodePaths !== undefined && status.claudeCodePaths.length > 0 && (
          <p className="dsha-muted dshcl-mono">
            {t.importSearched.replace('{paths}', status.claudeCodePaths.join(' · '))}
          </p>
        )}
        {hasAdopted && (
          <div className="dsha-actions">
            <button
              className="dsha-btn"
              disabled={busy !== null}
              aria-label={t.stopImporting}
              onClick={() => void stopImporting()}
            >
              {busy === 'adopt-disable' ? t.importing : t.stopImporting}
            </button>
          </div>
        )}

        {flow !== null && flow.status !== 'idle' && flow.status !== 'complete' && (
          <div className="dshcl-flow">
            <strong>{t.signInSection}</strong>
            <p className="dsha-muted">
              {flow?.status === 'error'
                ? `${t.loginFailed}: ${flow.error ?? ''}`
                : flow?.status === 'exchanging'
                  ? t.loginExchanging
                  : flow?.mode === 'manual' ? t.loginModeManual : t.loginModeLoopback}
            </p>
            {flow?.hint !== undefined && <p className="dsha-muted">{flow.hint}</p>}
            {flow?.fallbackReason !== undefined && (
              <p className="dsha-notice">{t.loginFallbackReason.replace('{detail}', flow.fallbackReason)}</p>
            )}
            {flow?.authUrl !== undefined && (
              <>
                <span className="dsha-label">{t.authorizeUrl}</span>
                <code className="dshcl-flow-url">{flow.authUrl}</code>
                <div className="dsha-actions">
                  <a className="dsha-btn" href={flow.authUrl} target="_blank" rel="noreferrer noopener">
                    {t.openAuthorizeUrl}
                  </a>
                </div>
              </>
            )}
            {flow?.redirectUri !== undefined && (
              <div className="dsha-row">
                <span className="dsha-label">{t.redirectUri}</span>
                <span className="dsha-value dshcl-mono">{flow.redirectUri}</span>
              </div>
            )}
            {/* Always rendered while a flow is pending, and never hidden behind a
                mode test: manual mode has no browser callback at all, so for those
                users this box is the only way to finish signing in. */}
            <div className="dshcl-paste">
              <strong>{t.manualPasteSection}</strong>
              <p className="dsha-muted">{t.manualPasteHint}</p>
              <div className="dshcl-paste-row">
                <input
                  type="text"
                  className="dsha-select"
                  aria-label={t.manualPasteSection}
                  placeholder={t.manualPastePlaceholder}
                  value={pasteValue}
                  disabled={busy !== null}
                  onChange={(event) => setPasteValue(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submitPaste()
                  }}
                />
                <button
                  className="dsha-btn dsha-btn-primary"
                  disabled={busy !== null || pasteValue.trim() === ''}
                  onClick={() => void submitPaste()}
                >
                  {busy === 'login-input' ? t.manualPasteSubmitting : t.manualPasteSubmit}
                </button>
                <button className="dsha-btn" disabled={busy !== null} onClick={() => void cancelLogin()}>
                  {t.cancelSignIn}
                </button>
              </div>
            </div>
          </div>
        )}
      </AccountPoolSection>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.connection}</h3>
        </div>
        {status?.account !== null && status?.account !== undefined && (
          <div className="dsha-row">
            <span className="dsha-label">{t.account}</span>
            <span className="dsha-value">
              {status.account.email ?? t.planUnknown}
              {status.account.subscriptionType !== null ? ` · ${status.account.subscriptionType}` : ''}
            </span>
          </div>
        )}
        <p className="dsha-notice">
          {status?.serving === false && status.conflict
            ? t.routeConflict.replace('{detail}', status.conflict)
            : t.routeOwned}
        </p>
        {connection !== null && (
          <p className={connection.connected ? 'dsha-muted' : 'dsha-notice'}>
            {connection.connected
              ? `${t.testSuccess} · ${t.testLatency.replace('{ms}', String(connection.latencyMs))}`
              : t.testFailed.replace('{detail}', connection.error ?? `HTTP ${connection.status}`)
                + ` (${connection.retryable ? t.testRetryable : t.testNotRetryable})`}
          </p>
        )}
        <div className="dsha-actions">
          <button
            className="dsha-btn"
            disabled={busy !== null || !status?.authenticated}
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
            disabled={busy !== null}
            onClick={() => void refreshCatalog()}
          >
            {busy === 'catalog' ? t.refreshingCatalog : t.refreshCatalog}
          </button>
        </div>
        <p className="dsha-muted dsha-models-hint">{t.modelsHint}</p>
        <ModelChecklist
          items={(status?.models ?? []).map((model: ClaudeModelOption) => ({
            id: model.id,
            name: model.name,
            hint: modelFacts(model, t).slice(1).join(' · ') || undefined,
            enabled: model.enabled,
          }))}
          busy={busy !== null}
          onToggle={toggleModel}
          onToggleAll={setAllModels}
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
          </div>
          <select
            className="dsha-select"
            aria-label={t.defaultReasoningEffort}
            value={status?.defaultReasoningEffort ?? ''}
            disabled={busy !== null}
            onChange={(event) => {
              const value = event.currentTarget.value
              void updateEffort(value === '' ? null : (value as ClaudeReasoningEffort))
            }}
          >
            <option value="">{t.defaultEffortAuto}</option>
            {/* Exactly what the catalog exposes, 'xhigh' included. */}
            {CLAUDE_REASONING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>{EFFORT_LABELS[effort]}</option>
            ))}
          </select>
        </div>
        <div className="dsha-pref-row">
          <div>
            <strong>{t.cacheTtl}</strong>
            <p className="dsha-muted">{t.cacheTtlHint}</p>
          </div>
          <select
            className="dsha-select"
            aria-label={t.cacheTtl}
            value={status?.cacheTtl ?? ''}
            disabled={busy !== null}
            onChange={(event) => {
              const value = event.currentTarget.value
              void updateCacheTtl(value === '' ? null : (value as ClaudeCacheTtl))
            }}
          >
            <option value="">{t.cacheTtlSubscription}</option>
            <option value="1h">{t.cacheTtl1h}</option>
            <option value="5m">{t.cacheTtl5m}</option>
          </select>
        </div>
        <p className="dsha-muted" style={{ paddingTop: 10 }}>{t.modelLadders}</p>
        {status?.models.map((model) => (
          <div key={model.id} className="dsha-row">
            <span className="dsha-label">{model.name}</span>
            <span className="dsha-value">
              {model.reasoningEfforts.length === 0 ? t.modelLadderNone : model.reasoningEfforts.join(' · ')}
            </span>
          </div>
        ))}
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.contextWindowSection}</h3>
        </div>
        <p className="dsha-muted">{t.contextWindowHint}</p>
        <ContextWindowEditor
          rows={contextModels.map((model: ClaudeModelOption) => ({
            id: model.id,
            name: model.name,
            draft: contextDrafts[model.id] ?? '',
            meta: model.defaultContextWindow < model.contextWindow
              ? formatCapacity(model.contextWindow)
              : undefined,
            inputLabel: `${model.name} context window`,
            hasOverride: status?.contextWindowOverrides[model.id] !== undefined,
            saving: savingModel === model.id,
          }))}
          labels={{
            tokens: t.tokens,
            save: t.save,
            saving: t.saving,
            reset: t.contextWindowReset,
            resetAll: t.contextWindowResetAll,
            empty: t.contextWindowNoneEnabled,
          }}
          busy={busy !== null}
          overrideCount={overrideCount}
          metaClassName="dshcl-model-meta"
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
            disabled={busy !== null || !status?.authenticated}
            onClick={() => void refreshQuota()}
          >
            {busy === 'quota' ? t.refreshingQuota : t.refreshQuota}
          </button>
        </div>
        <p className="dsha-muted">{t.quotaDesc}</p>
        {/* The progress bars moved into each account card: quota follows the
            account, so a bar here could only ever describe whichever account
            happened to be active when the snapshot was read. What stays is what
            has no per-account bar to live in — the extra-usage meter's own
            facts, the rate-limit status, the representative window and the
            freshness of this reading. */}
        <p className="dsha-muted">{t.quotaFactsScope}</p>

        {/* A refresh running behind the answer is rendered beside the snapshot
            rather than instead of it: the numbers on screen are real, just not
            the newest, and the follow-up poll brings the newer ones. */}
        {status?.quotaRefreshing === true && <p className="dsha-notice">{t.quotaRefreshing}</p>}
        {status?.quotaError !== undefined && status.quotaError !== null && (
          <p className="dsha-notice">{t.quotaError}: {status.quotaError}</p>
        )}

        {!status?.authenticated ? (
          <div className="dsha-empty">{t.quotaSignedOut}</div>
        ) : quota === null || quota === undefined ? (
          <div className="dsha-empty">{busy === 'quota' ? t.refreshingQuota : t.quotaEmpty}</div>
        ) : (
          <div className="dsha-quota-card">
            <div className="dsha-quota-title">
              <strong>{status.account?.subscriptionType ?? t.quotaSection}</strong>
              <span>{status.account?.email ?? t.planUnknown}</span>
            </div>

            {quota.extraUsage !== null && (
              <div className="dsha-meter-wrap">
                <div className="dsha-meter-label">
                  <span>{quota.extraUsage.label || t.extraUsage}</span>
                  <strong>
                    {quota.extraUsage.remainingPercent === null
                      ? t.quotaUnknown
                      : `${Math.round(quota.extraUsage.remainingPercent)}% ${t.left}`}
                  </strong>
                </div>
                <div className="dsha-meter-meta">
                  <span>{t.extraUsage}: {quota.extraUsage.enabled ? t.extraUsageEnabled : t.extraUsageDisabled}</span>
                  {quota.extraUsage.used !== null && <span>{t.usedLabel}: {quota.extraUsage.used}</span>}
                  {quota.extraUsage.limit !== null && (
                    <span>{t.extraUsageLimit}: {quota.extraUsage.limit}</span>
                  )}
                </div>
              </div>
            )}

            {quota.status !== null && (
              <div className="dsha-row">
                <span className="dsha-label">{t.quotaStatus}</span>
                <span className="dsha-value">{quota.status}</span>
              </div>
            )}
            {quota.representativeClaim !== null && (
              <div className="dsha-row">
                <span className="dsha-label">{t.quotaRepresentative}</span>
                <span className="dsha-value">{quota.representativeClaim}</span>
              </div>
            )}

            {windows.length === 0 && quota.extraUsage === null && (
              <div className="dsha-empty">{t.quotaEmpty}</div>
            )}

            <div className="dsha-timestamp">
              {quota.fetchedAt === null
                ? t.observedAt.replace('{time}', formatDate(quota.observedAt))
                : t.updatedAt.replace('{time}', formatDate(quota.fetchedAt))}
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
