/**
 * Qoder（订阅）设置卡片。
 *
 * 纯渲染：状态、副作用与请求都在 'useQoderSection.ts'，两者之间只通过一个具名结构
 * 交接（GLM / Step Code 同款分工）。
 *
 * 本文件没有新建任何 UI 组件：进入入口（hub 卡片）在 hub/providers.tsx，账号池与它的
 * 配额条在 AccountPoolSection，模型勾选在 ModelChecklist，上下文窗口在
 * ContextWindowEditor，输入框胶囊在 QoderComposerQuota.tsx。
 *
 * 两条它自己负责的渲染规则：
 *
 *   1. **能力只画契约里的字段**：图片输入、思考档位、上下文窗口、输出预算全部来自
 *      DTO 字段（`supportsImages` / `reasoningEfforts` / `contextWindow` /
 *      `defaultMaxTokens`），客户端不按模型名推断任何一项；同一事实只呈现一次；
 *   2. **额度画绝对量，缓存画 token 维度**：额度是三只桶的总量/已用/剩余（上游自述的
 *      单位），缺桶不画；缓存只有读入/写入/样本，没数据就是占位符；单价未公开，
 *      整页不出现任何金额。
 *
 * 版面纪律（全卡适用）：**每个分组标题下最多留一行说明**，其余原句收进 .dshq-details
 * 折叠区（moreNotes 辅助函数），阅读顺序因此固定为「标题 → 一句话 → 控件 → 折叠的补充
 * 说明」。
 */
import React from 'react'
import {
  QODER_REGIONS,
  isQoderReasoningEffort,
  isQoderRegion,
  type QoderModelOption,
  type QoderQuotaBucketDto,
  type QoderReasoningEffort,
} from '../../shared/qoder-contracts.ts'
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import { ContextWindowEditor } from '../common/ContextWindowEditor.tsx'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import { formatCapacity, formatDate, formatTokenCount } from '../common/format.ts'
import { adoptReasonText, quotaBucketText, regionText, zh, type QoderLocaleKey, NS_QODER } from './locales.ts'
import { useQoderSection, type QoderSectionProps } from './useQoderSection.ts'
import { useLineDict } from '../common/line-locale.ts'

/** 百分比，最多一位小数；调用方已经排除了非有限值。 */
function percentText(ratio: number): string {
  const value = Math.max(0, Math.min(1, ratio))
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value * 100) + '%'
  } catch {
    return Math.round(value * 100) + '%'
  }
}

/** 千分位；Intl 不可用时退回原值，不让一个格式化失败变成一次渲染失败。 */
function tokenText(value: number): string {
  try {
    return new Intl.NumberFormat().format(value)
  } catch {
    return String(value)
  }
}

/** 一只桶的量文本：「剩余 / 总额 单位」，缺哪格哪格就明说「未报」。 */
function bucketAmountText(
  bucket: QoderQuotaBucketDto,
  t: Record<QoderLocaleKey, string>,
): string {
  const unit = bucket.unit !== null && bucket.unit !== '' ? ' ' + bucket.unit : ''
  const remaining = bucket.remaining !== null ? tokenText(bucket.remaining) : '—'
  const total = bucket.total !== null ? tokenText(bucket.total) : '—'
  return t.quotaRemaining + ' ' + remaining + ' / ' + t.quotaTotal + ' ' + total + unit
}

/** 档位 → 字典键。六个取值一一对应，没有兜底串。 */
const EFFORT_LABEL_KEYS: Record<QoderReasoningEffort, QoderLocaleKey> = {
  minimal: 'effortMinimal',
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
  xhigh: 'effortXHigh',
  max: 'effortMax',
}

/**
 * 一组补充说明的折叠区。
 *
 * 版面纪律是「标题 → 一句话 → 控件 → 折叠的补充说明」，所以每组只把真正必要的那一句
 * 留在正文，其余**原句**收进这里。折叠不是删除：每一句仍然渲染进 DOM，仍然在
 * textContent 里，只是默认不占版面。空段落先滤掉，全空的组干脆不画这个折叠区。
 */
function moreNotes(summary: string, paragraphs: ReadonlyArray<string | null>): React.JSX.Element | null {
  const kept = paragraphs.filter((line): line is string => line !== null && line !== '')
  if (kept.length === 0) return null
  return (
    <details className="dshq-details">
      <summary>{summary}</summary>
      {kept.map((line, index) => <p key={'note:' + index}>{line}</p>)}
    </details>
  )
}

/**
 * 一行模型的能力摘要：`1M · text+image · 档位 low/high/max · 输出 131k`。
 *
 * 全部取自契约字段（窗口、`supportsImages`、`reasoningEfforts`、
 * `defaultMaxTokens`），客户端不按模型名推断任何一项。与 OpenDesign 卡同一写法：
 * 数据一行，散文进折叠区。
 */
export function qoderModelRowHint(model: QoderModelOption, t: typeof zh = zh): string {
  const capacity = formatTokenCount(model.contextWindow)
  const input = model.supportsImages ? 'text+image' : 'text'
  const efforts = model.reasoningEfforts.length === 0
    ? t.modelRowNoEfforts
    : t.modelRowEfforts.replace('{list}', model.reasoningEfforts.join('/'))
  const output = t.modelRowOutput.replace('{cap}', formatTokenCount(model.defaultMaxTokens))
  return `${capacity} · ${input} · ${efforts} · ${output}`
}

export function QoderSection({ onModelChange }: QoderSectionProps = {}): React.JSX.Element {
  const { state, derived, actions } = useQoderSection({ onModelChange })
  const {
    status, loading, busy, error, connection, adoptResult, pasteValue, region, pasteOpen,
    contextDrafts, savingModel,
  } = state
  const {
    accounts, models, contextModels, overrideCount, login, quota, authenticated, poolLabels,
    cache, cacheHitRatio: hitRatio,
  } = derived
  const {
    setRegion, login: startLogin, cancelLogin, submitPaste, setPasteValue, togglePaste, adopt,
    clearAdoptResult, accountAction, setStrategy, toggleModel, setAllModels, saveContextWindow,
    resetContextWindow, resetAllContextWindows, updateContextDraft, setDefaultReasoningEffort,
    refreshQuota, refreshCatalog, testConnection,
  } = actions

  const t = useLineDict(NS_QODER, zh)

  if (loading) {
    return (
      <div className="dsha-page">
        <div className="dsha-empty">{t.loading}</div>
      </div>
    )
  }

  return (
    <div className="dsha-page">
      <p className="dsha-muted">{t.pageDesc}</p>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.title}</h3>
        </div>
        {/* 线路总开关不在本页：它挂在 hub 卡片上。这里只保留下一次登录落在哪一区——
            它是本页所有登录入口共同的那一个参数。 */}
        <div className="dsha-pref-row">
          <div>
            <strong>{t.region}</strong>
            <p className="dsha-muted">{t.regionHint}</p>
          </div>
          <select
            className="dsha-select"
            aria-label={t.region}
            value={region}
            disabled={busy !== null}
            onChange={(event) => {
              if (isQoderRegion(event.currentTarget.value)) setRegion(event.currentTarget.value)
            }}
          >
            {QODER_REGIONS.map((value) => (
              <option key={value} value={value}>{regionText(value, t)}</option>
            ))}
          </select>
        </div>
        {moreNotes(t.moreNotes, [t.regionHintExtra])}
      </section>

      <AccountPoolSection
        accounts={accounts}
        activeAccountId={status?.activeAccountId}
        rotationStrategy={status?.rotationStrategy ?? 'sequential'}
        labels={poolLabels}
        busy={busy}
        showQuota
        onLogin={() => void startLogin(region)}
        onSetPrimary={(accountId) => void accountAction('set-primary', accountId)}
        onDelete={(accountId) => void accountAction('delete', accountId)}
        onClearCooldown={(accountId) => void accountAction('clear-cooldown', accountId)}
        onRelogin={(accountId) => void accountAction('relogin', accountId)}
        onSetStrategy={(strategy) => void setStrategy(strategy)}
        renderLoginActions={() => (
          // 标题行最多两个按钮（.dsha-grouphead 是一行 justify-content:space-between，
          // 第三个会被挤到下一行）。设备流只在支持它的区域出现（CN 没有设备流）；
          // PAT 粘贴不收进标题行——它是兜底，不是与浏览器登录并列的第二选择。
          <div className="dsha-account-add-actions">
            {region === 'global' && (
              <button
                className="dsha-btn dsha-btn-primary"
                disabled={busy !== null}
                aria-label={t.addAccount + '（' + regionText(region, t) + '）'}
                onClick={() => void startLogin(region)}
              >
                {busy === 'login:' + region ? t.authorizing : t.addAccount}
              </button>
            )}
            {/* 第二条登录路径：免去一次浏览器登录的快捷路径。它与主按钮并排在同一行，
                因为两者是「怎么登录」的两种做法。 */}
            <button
              className="dsha-btn"
              disabled={busy !== null}
              aria-label={t.adopt}
              onClick={() => void adopt()}
            >
              {busy === 'adopt' ? t.adopting : t.adopt}
            </button>
          </div>
        )}
        renderDetails={(account) => (
          <>
            <span>{t.region}: {regionText(account.region, t)}</span>
            {account.accountName ? <span>{account.accountName}</span> : null}
          </>
        )}
      >
        {/* 登录流程状态是**临时内容**：idle 时这一段整个不渲染，页面只剩
            「标题行 + 账号列表」。pending / complete / error 才出现一次。 */}
        {login !== null && login.status !== 'idle' && (
          <div className="dshq-flow">
            {login.status === 'pending' && (
              <>
                <p className="dsha-muted">{t.loginPending}</p>
                {/* authorizeUrl 始终下发：即使 host 打开浏览器失败，用户仍能手动打开。 */}
                {login.authorizeUrl !== undefined && login.authorizeUrl !== '' && (
                  <>
                    <span className="dsha-label">{t.authorizeUrl}</span>
                    <code className="dshq-flow-url">{login.authorizeUrl}</code>
                    <div className="dsha-actions">
                      <a className="dsha-btn" href={login.authorizeUrl} target="_blank" rel="noreferrer noopener">
                        {t.openAuthorizeUrl}
                      </a>
                    </div>
                  </>
                )}
                {login.progress !== undefined && login.progress !== '' && (
                  <div className="dsha-row">
                    <span className="dsha-label">{t.progress}</span>
                    <span className="dsha-value">{login.progress}</span>
                  </div>
                )}
                {login.pollIntervalSec !== undefined && (
                  <p className="dsha-muted">
                    {t.pollEvery.replace('{seconds}', String(login.pollIntervalSec))}
                  </p>
                )}
                {login.expiresAt !== undefined && (
                  <p className="dsha-muted">
                    {t.loginExpiresAt.replace('{time}', formatDate(login.expiresAt))}
                  </p>
                )}
              </>
            )}

            {/* 成功是把凭据落进号池的那一刻；账号之后被删掉时另说一句。 */}
            {login.status === 'complete' && !authenticated && (
              <p className="dsha-muted">{t.loginCompleteNoAccount}</p>
            )}
            {login.status === 'complete' && authenticated && (
              <>
                <p className="dsha-notice">
                  {t.loginComplete}
                  {login.uid !== undefined && login.uid !== '' ? ' ' + login.uid : ''}
                </p>
                {login.completedAt !== undefined && (
                  <p className="dsha-muted">
                    {t.loginCompletedAt.replace('{time}', formatDate(login.completedAt))}
                  </p>
                )}
              </>
            )}

            {login.status === 'error' && (
              <div className="dsha-error">
                <div>{login.error !== undefined && login.error !== '' ? t.loginError + ' ' + login.error : t.loginError}</div>
                <div>{login.retryable === true ? t.loginRetryable : t.loginNotRetryable}</div>
              </div>
            )}

            {login.status === 'pending' && (
              <div className="dsha-actions">
                <button className="dsha-btn" disabled={busy !== null} onClick={() => void cancelLogin()}>
                  {busy === 'login:cancel' ? t.cancelLoginBusy : t.cancelLogin}
                </button>
              </div>
            )}
          </div>
        )}

        {/* 导入结果落在账号区里、按钮的正下方。 */}
        {adoptResult !== null && (
          <div className="dsha-row">
            <span className="dsha-value">
              {adoptResult.adopted
                ? t.adoptAdopted.replace('{region}', regionText(adoptResult.region ?? region, t))
                : (adoptResult.reason === undefined
                  ? t.adoptNoAttempt
                  : adoptReasonText(adoptResult.reason, t) + ' ' + t.adoptFallback)}
            </span>
            <button className="dsha-btn" disabled={busy !== null} onClick={clearAdoptResult}>{t.dismiss}</button>
          </div>
        )}

        {/* 兜底入口行：闲置时它只有**一行**（一句 idle 说明 + PAT 粘贴开关）。
            idle 说明跟着「本进程还没开过流」走：号池里已经有账号时它说的是另一件事。 */}
        <div className="dshq-paste">
          {login !== null && login.status === 'idle' && (
            <span className="dsha-muted dshq-paste-note">
              {authenticated
                ? t.loginHaveAccounts.replace('{count}', String(accounts.length))
                : t.loginIdle}
            </span>
          )}
          <button
            type="button"
            className="dsha-btn"
            aria-expanded={pasteOpen}
            aria-controls="dshq-paste-body"
            onClick={togglePaste}
          >
            {t.manualPasteSection}
          </button>
          {pasteOpen && (
            <div className="dshq-paste-body" id="dshq-paste-body">
              <p className="dsha-muted">{t.manualPasteHint}</p>
              <div className="dshq-paste-row">
                <input
                  type="password"
                  className="dsha-select"
                  aria-label={t.manualPasteSection}
                  placeholder={t.manualPastePlaceholder}
                  value={pasteValue}
                  disabled={busy !== null}
                  // 这串 PAT 只活在这个受控 input 与提交那一行的局部变量里；
                  // type=password 只是不把它印在屏幕上，不是安全边界。
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
                  {busy === 'login-manual' ? t.manualPasteSubmitting : t.manualPasteSubmit}
                </button>
              </div>
            </div>
          )}
        </div>
      </AccountPoolSection>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.connection}</h3>
        </div>
        <p className="dsha-notice">
          {status?.serving === false && status.conflict
            ? t.routeConflict.replace('{detail}', status.conflict)
            : t.routeOwned}
        </p>
        {connection !== null && (
          <p className={connection.connected ? 'dsha-muted' : 'dsha-notice'}>
            {connection.connected
              ? [
                t.testSuccess,
                t.testLatency.replace('{ms}', String(connection.latencyMs)),
                connection.account?.alias ?? connection.account?.accountName ?? null,
                connection.model ?? null,
              ].filter((part): part is string => part !== null && part !== '').join(' · ')
              : t.testFailedDetail.replace('{detail}', connection.error ?? '—')}
          </p>
        )}
        <div className="dsha-actions">
          <button className="dsha-btn" disabled={busy !== null || !authenticated} onClick={() => void testConnection()}>
            {busy === 'connection' ? t.testingConnection : t.testConnection}
          </button>
        </div>
      </section>

      {/* 缓存：只画 token 维度，缺数据一律画占位；整页没有金额（订阅单价未公开）。 */}
      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.cacheSection}</h3>
        </div>
        <p className="dsha-muted">{t.cacheStatScope}</p>
        {cache === null ? (
          <div className="dsha-empty">{t.cacheEmpty}</div>
        ) : (
          <div className="dsha-quota-card">
            <div className="dsha-meter-wrap">
              <div className="dsha-meter-label">
                <span>{t.cacheHitRatio}</span>
                {/* 分母为 0 时是占位符而不是 0%：0% 说的是「一个都没命中」，而事实是
                    「还没有样本」。 */}
                <strong>{hitRatio === null ? t.cacheHitRatioUnavailable : percentText(hitRatio)}</strong>
              </div>
              {hitRatio !== null && (
                <div className={'dsha-meter ' + (hitRatio >= 0.9 ? 'dsha-meter-green' : 'dsha-meter-cyan')}>
                  <span style={{ width: Math.round(hitRatio * 100) + '%' }} />
                </div>
              )}
              <div className="dsha-meter-meta">
                <span>{t.cacheReadTokens}: {tokenText(cache.cacheReadTokens)}</span>
                <span>{t.cacheMissedTokens}: {tokenText(cache.missedInputTokens)}</span>
                {cache.cacheWriteTokens > 0 && <span>{t.cacheWriteTokens}: {tokenText(cache.cacheWriteTokens)}</span>}
                {cache.requests !== null && <span>{t.cacheRequests}: {tokenText(cache.requests)}</span>}
              </div>
            </div>
          </div>
        )}
        {moreNotes(t.moreNotes, [t.cacheDesc])}
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.modelsSection}</h3>
          <button className="dsha-btn" disabled={busy !== null} onClick={() => void refreshCatalog()}>
            {busy === 'catalog' ? t.refreshingCatalog : t.refreshCatalog}
          </button>
        </div>
        <p className="dsha-muted dsha-models-hint">{t.modelsHint}</p>
        {models.length === 0 ? (
          <div className="dsha-empty">{t.modelsUnavailable}</div>
        ) : (
          <>
            <ModelChecklist
              items={models.map((model: QoderModelOption) => ({
                id: model.id,
                name: model.name,
                // 逐模型的一行能力：窗口 · 输入模态 · 档位 · 输出预算。曾经不画
                // （「模型行下面不需要介绍文字」指的是 host 那段散文式 hint），
                // 但一行数据与一段介绍不是同一件事——用户要在勾选时就知道这个
                // 模型能收多大的上下文、收不收图、有几档思考。
                hint: qoderModelRowHint(model, t),
                enabled: model.enabled,
              }))}
              busy={busy !== null}
              onToggle={toggleModel}
              onToggleAll={setAllModels}
              labels={{
                selectAll: t.selectAll,
                clearAll: t.unselectAll,
                countTemplate: t.modelChecklistCount,
                list: t.modelsSection,
              }}
            />
            {/* 选择语义必须写在按钮旁边：清空勾选 = 全部模型都不可用（三态里的 []）。 */}
            <p className="dsha-muted">{t.enabledModelIdsSemantics}</p>
          </>
        )}
        {moreNotes(t.moreNotes, [t.modelsHintExtra])}
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.defaultEffort}</h3>
        </div>
        <div className="dsha-pref-row">
          <div>
            <strong>{t.defaultEffort}</strong>
            <p className="dsha-muted">{t.defaultEffortHint}</p>
          </div>
          <select
            className="dsha-select"
            aria-label={t.defaultEffort}
            value={status?.defaultReasoningEffort ?? ''}
            disabled={busy !== null}
            onChange={(event) => {
              const value = event.currentTarget.value
              void setDefaultReasoningEffort(isQoderReasoningEffort(value) ? value : null)
            }}
          >
            <option value="">{t.defaultEffortModel}</option>
            {Object.entries(EFFORT_LABEL_KEYS).map(([effort, key]) => (
              <option key={effort} value={effort}>{t[key as QoderLocaleKey]}</option>
            ))}
          </select>
        </div>
        {moreNotes(t.moreNotes, [t.defaultEffortHintExtra])}
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.contextWindowSection}</h3>
        </div>
        <p className="dsha-muted">{t.contextWindowHint}</p>
        <ContextWindowEditor
          rows={contextModels.map((model: QoderModelOption) => ({
            id: model.id,
            name: model.name,
            draft: contextDrafts[model.id] ?? '',
            meta: model.defaultContextWindow < model.contextWindow ? formatCapacity(model.contextWindow) : undefined,
            inputLabel: model.name + ' ' + t.contextWindowSection,
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
          metaClassName="dshq-model-meta"
          onDraftChange={updateContextDraft}
          onCommit={(id) => void saveContextWindow(id)}
          onReset={(id) => void resetContextWindow(id)}
          onResetAll={() => void resetAllContextWindows()}
        />
        {moreNotes(t.moreNotes, [t.contextWindowHintExtra])}
      </section>

      {/* 额度：三只桶分开渲染，绝不揉成一份「看起来一样」的进度条。 */}
      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.quotaSection}</h3>
          <button className="dsha-btn" disabled={busy !== null || !authenticated} onClick={() => void refreshQuota()}>
            {busy === 'quota' ? t.quotaRefreshing : t.quotaRefresh}
          </button>
        </div>
        {/* 标题下只留这一句：额度数字跟着账号卡片走。 */}
        <p className="dsha-muted">{poolLabels.quotaFactsScope}</p>
        {status?.quotaRefreshing === true && <p className="dsha-notice">{t.quotaRefreshingNote}</p>}
        {status?.quotaError !== undefined && status.quotaError !== null && status.quotaError !== '' && (
          <p className="dsha-notice">{t.quotaErrorLabel + ': ' + status.quotaError}</p>
        )}

        {!authenticated ? (
          <div className="dsha-empty">{t.quotaSignedOut}</div>
        ) : quota === null ? (
          <div className="dsha-empty">{busy === 'quota' ? t.quotaRefreshing : t.quotaEmpty}</div>
        ) : (
          <div className="dsha-quota-card">
            {/* 事实走紧凑网格：一格一件事、行高一致。 */}
            <div className="dshq-fact-grid">
              <div className="dshq-fact">
                <span>{t.quotaExpiresAt}</span>
                <span>{quota.expiresAt !== null ? formatDate(quota.expiresAt) : '—'}</span>
              </div>
              <div className="dshq-fact">
                <span>{t.quotaReadAt}</span>
                <span>{formatDate(quota.fetchedAt)}</span>
              </div>
              <div className="dshq-fact">
                <span>{t.quotaRegion}</span>
                <span>{regionText(quota.region, t)}</span>
              </div>
            </div>

            {quota.buckets.length === 0 ? (
              <div className="dsha-empty">{t.quotaEmpty}</div>
            ) : (
              <div className="dshq-quota-list">
                {quota.buckets.map((bucket, index) => (
                  <div className="dshq-quota-row" key={bucket.kind + ':' + index}>
                    <span className="dshq-quota-name">{quotaBucketText(bucket.kind, t)}</span>
                    <span className="dshq-quota-value">{bucketAmountText(bucket, t)}</span>
                    {bucket.used !== null && bucket.total !== null && bucket.total > 0 && (
                      <span className="dshq-quota-meta">
                        {t.quotaUsed} {percentText(bucket.used / bucket.total)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {moreNotes(t.moreNotes, [t.quotaDesc])}
      </section>

      {error !== null && (
        <div className="dsha-error">
          <div>{error}</div>
        </div>
      )}
    </div>
  )
}
