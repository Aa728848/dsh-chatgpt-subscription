/**
 * GLM（ZCode 账号）设置卡片。
 *
 * 纯渲染：状态、副作用与请求都在 'useGlmCodingPlanSection.ts'，两者之间只通过
 * 一个具名结构交接（MinimaxCodeSection / StepCodeSection 同款分工）。
 *
 * 三条需求方的 UI 硬要求由现成共享组件承担，本文件没有新建任何 UI 组件：
 *
 *   1. 进入入口（hub 卡片：图标 + 名称 + 「N 个账号 / M/N 个模型可用」+ 开关 + chevron）
 *      —— hub/providers.tsx 的 descriptor + hub/HubOverview.tsx，点进来就是本卡片；
 *   2. 配额显示额度（标签 + 进度条 + 百分比 + 「N 天后重置」）
 *      —— AccountPoolSection 的 showQuota + common/account-quota.tsx，
 *      窗口名由共享组件按 windowDurationMins 本地化（5 小时 / 1 周 / 1 月），
 *      所以本页的配额区只画「没有账号卡进度条可画」的那些事实；
 *   3. 模型选择（品牌图标 + 模型名 + 一句话描述 + 行尾勾）
 *      —— common/ModelChecklist.tsx，hint 直接用契约里的 GlmModelOption.hint
 *      （host 由随包目录生成，客户端不从模型名推断任何能力）。
 */
import React from 'react'
import type { GlmAccountSummaryDto, GlmModelOption, GlmRegion } from '../../shared/glm-coding-plan-contracts.ts'
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import { ContextWindowEditor } from '../common/ContextWindowEditor.tsx'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import { formatCapacity, formatDate } from '../common/format.ts'
import { adoptReasonText, allowanceKindText, zh, NS_GLM_CODING_PLAN } from './locales.ts'
import { useGlmCodingPlanSection, type GlmCodingPlanSectionProps } from './useGlmCodingPlanSection.ts'
import { useLineDict } from '../common/line-locale.ts'

/** 区域的人类可读名，登录与 adopt 两条入口的结果都要说清楚落在哪一区。 */
function regionLabel(region: GlmRegion, t: typeof zh): string {
  return region === 'cn' ? t.regionCn : t.regionIntl
}

export function GlmCodingPlanSection({ onModelChange }: GlmCodingPlanSectionProps = {}): React.JSX.Element {
  const { state, derived, actions } = useGlmCodingPlanSection({ onModelChange })
  const {
    status, loading, busy, error, connection, adoptResult, pasteValue, region, pasteOpen, contextDrafts, savingModel,
  } = state
  const { accounts, models, contextModels, overrideCount, login, quota, authenticated, poolLabels } = derived
  const {
    setRegion, login: startLogin, cancelLogin, submitPaste, setPasteValue, togglePaste, adopt, clearAdoptResult,
    accountAction, setStrategy, toggleModel, setAllModels, saveContextWindow, resetContextWindow,
    resetAllContextWindows, updateContextDraft, refreshQuota, refreshCatalog, testConnection,
  } = actions

  const t = useLineDict(NS_GLM_CODING_PLAN, zh)

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
        {/* 线路总开关不在本页：它挂在 hub 卡片上（hub/providers.tsx 的 descriptor.setEnabled），
            详情页再画一个只会与那里的状态不同步，所以这里只保留区域选择。 */}
        {/* 区域是凭据的属性：两个部署各自的账号各自独立，池内可以同时存在两区账号。
            这里这一个选择器是下方账号区**全部**登录入口共同的参数：「添加账号」按它发起，
            「导入本机登录态」与「手工粘贴授权码」也按它落在哪一区。 */}
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
            onChange={(event) => setRegion(event.currentTarget.value as GlmRegion)}
          >
            <option value="cn">{t.regionCn}</option>
            <option value="intl">{t.regionIntl}</option>
          </select>
        </div>
      </section>

      <AccountPoolSection<GlmAccountSummaryDto>
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
          // 标题行只放两个按钮，与 Claude 卡同款：.dsha-grouphead 是一行
          // justify-content:space-between，第三个按钮会被 .dsha-account-add-actions 的
          // flex-wrap 挤到下一行（需求方实测反馈）。为此区域**不再**各占一个按钮——
          // 它只是上方那张卡里一个 select 上的偏好，一个主按钮按当前区域发起即可，
          // 于是「浏览器登录」与「导入本机登录态」两条登录路径都留在标题行，
          // 页面下面是账号列表，没有第二个「登录授权」区。
          <div className="dsha-account-add-actions">
            <button
              className="dsha-btn dsha-btn-primary"
              disabled={busy !== null}
              aria-label={`${t.addAccount}（${regionLabel(region, t)}）`}
              onClick={() => void startLogin(region)}
            >
              {busy === `login:${region}` ? t.authorizing : t.addAccount}
            </button>
            {/* 第二条登录路径：免去一次浏览器登录的快捷路径。它与主按钮并排在同一行，
                因为两者是「怎么登录」的两种做法，而不是两件不相干的事。 */}
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
            <span>{t.region}: {regionLabel(account.region, t)}</span>
            {account.accountName ? <span>{account.accountName}</span> : null}
            {account.organizationId ? (
              <span className="dshglm-mono" title={account.organizationId}>{account.organizationId}</span>
            ) : null}
          </>
        )}
      >
        {/* 登录流程状态是**临时内容**，因此没有自己的小标题、也不常驻版面：idle 时这一段
            整个不渲染，页面于是与 Claude 卡一样只剩「标题行 + 账号列表」。pending / complete /
            error 才出现一次，落在账号列表下面、兜底入口行的上面——紧挨着它解释的那件事。 */}
        {login !== null && login.status !== 'idle' && (
          <div className="dshglm-flow">
            {login.status === 'pending' && (
              <>
                <p className="dsha-muted">{t.loginPending}</p>
                {/* authorizeUrl 始终下发：即使 host 打开浏览器失败，用户仍能手动打开。 */}
                {login.authorizeUrl !== undefined && login.authorizeUrl !== '' && (
                  <>
                    <span className="dsha-label">{t.authorizeUrl}</span>
                    <code className="dshglm-flow-url">{login.authorizeUrl}</code>
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

            {/* 成功是把凭据换算出来并落进号池的那一刻，所以除了邮箱还要说出时间：
                host 保留这条终态直到下一次开流，账号池那几行却会被下一次登录刷新。
                账号之后被删掉时另说一句：号池里没有账号还宣称「已加入号池」是谎报。 */}
            {login.status === 'complete' && !authenticated && (
              <p className="dsha-muted">{t.loginCompleteNoAccount}</p>
            )}
            {login.status === 'complete' && authenticated && (
              <>
                <p className="dsha-notice">
                  {t.loginComplete}
                  {login.email !== undefined && login.email !== '' ? ` ${login.email}` : ''}
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
                <div>{login.error !== undefined && login.error !== '' ? `${t.loginError} ${login.error}` : t.loginError}</div>
                {/* retryable 来自契约：4xx / 信封 code!=0 / 未知 status 是致命的，
                    5xx 与畸形 200 才值得自动回落。两种失败的下一步不同，因此分两句。 */}
                <div>{login.retryable === true ? t.loginRetryable : t.loginNotRetryable}</div>
              </div>
            )}

            {/* 「取消登录」是**流程控制**，不是粘贴的一部分：它撤销的是这一次浏览器
                授权流程，所以与流程状态同级（放在上面 pending 块之后），而不是与
                「提交授权码」并排——并排会让人以为它只影响粘贴。
                只在确实有进行中的流程时出现：idle / complete / error 都没有可取消的东西。 */}
            {login.status === 'pending' && (
              <div className="dsha-actions">
                <button className="dsha-btn" disabled={busy !== null} onClick={() => void cancelLogin()}>
                  {busy === 'login:cancel' ? t.cancelLoginBusy : t.cancelLogin}
                </button>
              </div>
            )}
          </div>
        )}

        {/* 导入结果落在账号区里、按钮的正下方（按钮本身在标题行）：点了按钮却在远处看到
            结果，用户会不知道是哪一步给的。它不进标题行——一行 space-between 的标题行
            放不下第二段文字，结果必须是自己的行。 */}
        {adoptResult !== null && (
          <div className="dsha-row">
            <span className="dsha-value">
              {adoptResult.adopted
                ? t.adoptAdopted.replace('{region}', regionLabel(adoptResult.region ?? region, t))
                : (adoptResult.reason === undefined
                  ? t.adoptNoAttempt
                  : `${adoptReasonText(adoptResult.reason, t)} ${t.adoptFallback}`)}
            </span>
            <button className="dsha-btn" disabled={busy !== null} onClick={clearAdoptResult}>{t.dismiss}</button>
          </div>
        )}

        {/* 兜底入口行：闲置时它只有**一行**（一句 idle 说明 + 手工粘贴开关），而不是一段
            带「登录授权」小标题的登录区。手工粘贴兜底**不删**：浏览器回调被拦时它是唯一能
            完成登录的地方，所以开关常驻、输入区默认收起（展开态由 useGlmCodingPlanSection
            跟着 pending / error 自动打开），需要时随时点开。

            idle 说明跟着这一行走，是因为 idle 说的是「**本进程**还没开过流」，不是「你没
            登录」：host 的 flow 是进程内变量（oauth.ts 的 resetWebLogins），重启 host 后
            回到 idle，而号池里的账号还在。所以两态必须分两句：池里已经有账号时说
            「已有 N 个可用」，只有池子真的空着才说「尚未开始登录」。判据取 authenticated
            （host 由 pool.accounts.length > 0 下发），不是登录流程的状态——后者在重启之后
            已经不再描述任何登录事实。 */}
        <div className="dshglm-paste">
          {login !== null && login.status === 'idle' && (
            <span className="dsha-muted dshglm-paste-note">
              {authenticated
                ? t.loginHaveAccounts.replace('{count}', String(accounts.length))
                : t.loginIdle}
            </span>
          )}
          <button
            type="button"
            className="dsha-btn"
            aria-expanded={pasteOpen}
            aria-controls="dshglm-paste-body"
            onClick={togglePaste}
          >
            {t.manualPasteSection}
          </button>
          {pasteOpen && (
            <div className="dshglm-paste-body" id="dshglm-paste-body">
              <p className="dsha-muted">{t.manualPasteHint}</p>
              <div className="dshglm-paste-row">
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

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.modelsSection}</h3>
          <button className="dsha-btn" disabled={busy !== null} onClick={() => void refreshCatalog()}>
            {busy === 'catalog' ? t.refreshingCatalog : t.refreshCatalog}
          </button>
        </div>
        <p className="dsha-muted dsha-models-hint">{t.modelsHint}</p>
        {models.length === 0
          ? <div className="dsha-empty">{t.modelsUnavailable}</div>
          : (
            <ModelChecklist
              items={models.map((model: GlmModelOption) => ({
                id: model.id,
                name: model.name,
                // hint 由 host 从逐模型能力表生成（思考形态 / 档位 / 输入模态 / 上下文窗口），
                // 客户端一个字都不改写，也不自己拼一条。
                hint: model.hint === '' ? undefined : model.hint,
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
          )}
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.contextWindowSection}</h3>
        </div>
        <p className="dsha-muted">{t.contextWindowHint}</p>
        <ContextWindowEditor
          rows={contextModels.map((model: GlmModelOption) => ({
            id: model.id,
            name: model.name,
            draft: contextDrafts[model.id] ?? '',
            meta: model.defaultContextWindow < model.contextWindow ? formatCapacity(model.contextWindow) : undefined,
            inputLabel: `${model.name} ${t.contextWindowSection}`,
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
          metaClassName="dshglm-model-meta"
          onDraftChange={updateContextDraft}
          onCommit={(id) => void saveContextWindow(id)}
          onReset={(id) => void resetContextWindow(id)}
          onResetAll={() => void resetAllContextWindows()}
        />
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.quotaSection}</h3>
          <button className="dsha-btn" disabled={busy !== null || !authenticated} onClick={() => void refreshQuota()}>
            {busy === 'quota' ? t.quotaRefreshing : t.quotaRefresh}
          </button>
        </div>
        <p className="dsha-muted">{t.quotaDesc}</p>
        {/* 进度条跟着账号走，所以画在每个账号卡片里（AccountPoolSection showQuota）。
            这里只画没有账号卡进度条可画的事实，并且窗口名由共享组件按窗口长度本地化，
            本文件不硬编码「5 小时 / 1 周 / 1 月」。 */}
        <p className="dsha-muted">{poolLabels.quotaFactsScope}</p>
        {status?.quotaRefreshing === true && <p className="dsha-notice">{t.quotaRefreshingNote}</p>}
        {status?.quotaError !== undefined && status.quotaError !== null && status.quotaError !== '' && (
          <p className="dsha-notice">{`${t.quotaErrorLabel}: ${status.quotaError}`}</p>
        )}

        {/* 额度类型画在快照分支**外面**：免费体验额度账号恰恰可能读不到配额快照，
            而那正是最需要如实说明「你用的是免费额度、不是付费套餐」的时候。 */}
        {authenticated && (
          <div className="dsha-row">
            <span className="dsha-label">{t.quotaAllowance}</span>
            <span className="dsha-value">
              {allowanceKindText(status?.allowance ?? quota?.allowance, t)}
            </span>
          </div>
        )}
        {authenticated && <p className="dsha-muted">{t.quotaAllowanceHint}</p>}
        {!authenticated ? (
          <div className="dsha-empty">{t.quotaSignedOut}</div>
        ) : quota === null ? (
          <div className="dsha-empty">{busy === 'quota' ? t.quotaRefreshing : t.quotaEmpty}</div>
        ) : (
          <div className="dsha-quota-card">
            {/* 套餐名与档位只在上游真的给出付费套餐档位时画：给一个免费体验额度账号
                显示「档位: —」的套餐行，会让人以为他买了套餐。上方的额度类型行已经
                如实说明了来源。 */}
            {quota.planLevel !== null && quota.planLevel !== undefined && (
              <div className="dsha-quota-title">
                <strong>{quota.planName ?? t.quotaPlan}</strong>
                <span>{t.quotaPlanLevel}: {quota.planLevel}</span>
              </div>
            )}
            <div className="dsha-row">
              <span className="dsha-label">{t.quotaRenews}</span>
              <span className="dsha-value">{formatDate(quota.renewsAt)}</span>
            </div>
            <div className="dsha-row">
              <span className="dsha-label">{t.quotaReadAt}</span>
              <span className="dsha-value">{formatDate(quota.fetchedAt)}</span>
            </div>
            {quota.sources.length > 0 && (
              <div className="dsha-row">
                <span className="dsha-label">{t.quotaSources}</span>
                <span className="dsha-value dshglm-mono">{quota.sources.join(' · ')}</span>
              </div>
            )}
            {/* 未知 unit 不下发、不发明窗口（契约 §GlmQuotaWindowKey），所以空窗口
                要说成「上游没给窗口」，而不是画一条空进度条。 */}
            {quota.windows.length === 0 && <div className="dsha-empty">{t.quotaEmpty}</div>}
          </div>
        )}
      </section>

      {error !== null && (
        <div className="dsha-error">
          <div>{error}</div>
        </div>
      )}
    </div>
  )
}
