/**
 * Step Code（Step Plan 订阅）设置卡片。
 *
 * 纯渲染：状态、副作用与请求都在 'useStepCodeSection.ts'，两者之间只通过一个具名结构
 * 交接（GLM / MiniMax Code 同款分工）。
 *
 * 本文件没有新建任何 UI 组件：进入入口（hub 卡片）在 hub/providers.tsx，账号池与它的
 * 配额条在 AccountPoolSection，模型勾选在 ModelChecklist，上下文窗口在
 * ContextWindowEditor，输入框胶囊在 StepCodeComposerQuota.tsx。
 *
 * 两条它自己负责的渲染规则：
 *
 *   1. **能力只画契约里的字段**：图片输入、思考档位、上下文窗口全部来自 host 生成的
 *      hint，客户端不按模型名推断任何一项；同一事实只呈现一次——勾选列表的行已经带了
 *      那句话，所以下面不再另起一块把已勾选模型的能力重列一遍；
 *   2. **缓存只画 token 维度**：读入量与命中率一条条，没数据就是占位符；写侧在本线路
 *      恒为 0，用 STEP_CODE_CACHE_WRITE_NOTE 标注而不是画一条永远是 0 的进度条；
 *      单价未文档化，因此整页不出现任何金额。
 *
 * 版面纪律（全卡适用）：**每个分组标题下最多留一行说明**，其余原句收进 .dshsc-details
 * 折叠区（moreNotes 辅助函数），阅读顺序因此固定为「标题 → 一句话 → 控件 → 折叠的补充
 * 说明」。实现坐标（读侧字段优先级链、端点路径、plan_family 的机器值）不留在正文：
 * 它们解释的是这份数据怎么来的，而不是用户现在该做什么——但也绝不删除，一律进折叠区。
 */
import React from 'react'
import {
  STEP_CODE_CACHE_READ_FIELD_ORDER,
  STEP_CODE_PROFILES,
  isStepCodeProfile,
  isStepCodeReasoningEffort,
  stepCodeRegionOf,
  type StepCodeModelOption,
  type StepCodeProfile,
  type StepCodeQuotaSnapshotDto,
  type StepCodeQuotaWindow,
  type StepCodeReasoningEffort,
} from '../../shared/step-code-contracts.ts'
import { AccountPoolSection } from '../common/AccountPoolSection.tsx'
import { ContextWindowEditor } from '../common/ContextWindowEditor.tsx'
import { ModelChecklist } from '../common/ModelChecklist.tsx'
import { formatCapacity, formatDate } from '../common/format.ts'
import {
  adoptReasonText,
  profileText,
  quotaCredentialSourceText,
  quotaKindText,
  quotaWindowKeyText,
  zh,
  type StepCodeLocaleKey,
} from './locales.ts'
import {
  CACHE_WRITE_NOTE,
  useStepCodeSection,
  type StepCodeSectionProps,
} from './useStepCodeSection.ts'

/** 区域的人类可读名。区域由凭据里的 profile 唯一决定，所以这里只是把 profile 说清楚。 */
function regionLabel(profile: StepCodeProfile, t: Record<StepCodeLocaleKey, string>): string {
  return stepCodeRegionOf(profile) === 'cn' ? t.regionCn : t.regionIntl
}

/** 百分比，最多一位小数；调用方已经排除了非有限值。 */
function percentText(ratio: number): string {
  const value = Math.max(0, Math.min(1, ratio))
  try {
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value * 100)}%`
  } catch {
    return `${Math.round(value * 100)}%`
  }
}

/** 一条用量进度的颜色等级：80% 起警告，95% 起危险。 */
function levelFor(usedPercent: number): 'normal' | 'warning' | 'danger' {
  return usedPercent >= 95 ? 'danger' : usedPercent >= 80 ? 'warning' : 'normal'
}

/** 千分位；Intl 不可用时退回原值，不让一个格式化失败变成一次渲染失败。 */
function tokenText(value: number): string {
  try {
    return new Intl.NumberFormat().format(value)
  } catch {
    return String(value)
  }
}

/**
 * 快照里的「机器坐标」合成一句：plan_family 的机器值与实际应答的端点路径。
 *
 * 它们解释的是这份快照**怎么来的**，不是用户现在该做什么，所以不进正文；但也绝不
 * 删除——调用方把它们放进本组的折叠区。没有任何值时返回 null，折叠区便少这一段。
 */
function quotaMachineFactsText(
  quota: StepCodeQuotaSnapshotDto | null,
  t: Record<StepCodeLocaleKey, string>,
): string | null {
  if (quota === null) return null
  const parts = [
    quota.planFamily !== null ? `${t.quotaPlanFamily}: ${quota.planFamily}` : null,
    quota.sources.length > 0 ? `${t.quotaSources}: ${quota.sources.join(' · ')}` : null,
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? null : parts.join(' · ')
}

/** 档位 → 字典键。六个取值一一对应，没有兜底串。 */
const EFFORT_LABEL_KEYS: Record<StepCodeReasoningEffort, StepCodeLocaleKey> = {
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
    <details className="dshsc-details">
      <summary>{summary}</summary>
      {kept.map((line, index) => <p key={`note:${index}`}>{line}</p>)}
    </details>
  )
}

/**
 * 老式窗口的一行：已用百分比 + 重置时刻。
 *
 * `usedPercent` 为 null（上游没给有界额度）时说成「没给百分比」而不是画一条 0% 的条——
 * 「不知道」与「一点没花」在界面上必须长得不一样。
 */
function quotaWindowRow(
  window: StepCodeQuotaWindow,
  index: number,
  t: Record<StepCodeLocaleKey, string>,
): React.JSX.Element {
  const name = quotaWindowKeyText(window.key, t)
  const measured = window.usedPercent !== null && Number.isFinite(window.usedPercent)
  const used = measured && window.usedPercent !== null ? Math.max(0, Math.min(100, window.usedPercent)) : 0
  return (
    <div className="dshsc-quota-row" key={`${window.key}:${index}`} data-level={measured ? levelFor(used) : 'normal'}>
      <span className="dshsc-quota-name" title={window.key}>{name}</span>
      {measured
        ? (
          <span
            className="dshsc-quota-track"
            role="progressbar"
            aria-label={`${name}: ${percentText(used / 100)} ${t.quotaUsed}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={used}
          >
            <span style={{ width: `${used}%` }} />
          </span>
        )
        : <span className="dshsc-quota-value">{t.quotaUsedUnknown}</span>}
      <span className="dshsc-quota-value">
        {measured ? percentText(used / 100) : t.quotaUsedUnknown}
      </span>
      <span className="dshsc-quota-meta">
        {window.resetsAt !== null && window.resetsAt > 0
          ? `${t.quotaResets} ${formatDate(window.resetsAt)}`
          : t.quotaNoReset}
      </span>
    </div>
  )
}

export function StepCodeSection({ onModelChange }: StepCodeSectionProps = {}): React.JSX.Element {
  const { state, derived, actions } = useStepCodeSection({ onModelChange })
  const {
    status, loading, busy, error, connection, adoptResult, pasteValue, profile, pasteOpen,
    contextDrafts, savingModel, quotaAccount, quotaPassword, quotaToken,
  } = state
  const {
    accounts, models, contextModels, overrideCount, login, quota, authenticated, poolLabels,
    cache, cacheHitRatio: hitRatio, quotaCredential,
  } = derived
  const {
    setProfile, login: startLogin, cancelLogin, submitPaste, setPasteValue, togglePaste, adopt,
    clearAdoptResult, accountAction, setStrategy, toggleModel, setAllModels, saveContextWindow,
    resetContextWindow, resetAllContextWindows, updateContextDraft, setDefaultReasoningEffort,
    setCacheRequestParams, refreshQuota, refreshCatalog, testConnection, setQuotaAccount,
    setQuotaPassword, setQuotaToken, submitQuotaPassword, submitQuotaToken, clearQuotaCredential,
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
      <p className="dsha-muted">{t.pageDesc}</p>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.title}</h3>
        </div>
        {/* 线路总开关不在本页：它挂在 hub 卡片上，详情页再画一个只会与那里的状态不同步。
            这里只保留凭据类型的选择——它是本页所有登录入口共同的那一个参数。 */}
        <div className="dsha-pref-row">
          <div>
            <strong>{t.profile}</strong>
            <p className="dsha-muted">{t.profileHint}</p>
          </div>
          <select
            className="dsha-select"
            aria-label={t.profile}
            value={profile}
            disabled={busy !== null}
            onChange={(event) => {
              if (isStepCodeProfile(event.currentTarget.value)) setProfile(event.currentTarget.value)
            }}
          >
            {STEP_CODE_PROFILES.map((value) => (
              <option key={value} value={value}>{profileText(value, t)}</option>
            ))}
          </select>
        </div>
        <div className="dsha-row">
          <span className="dsha-label">{t.region}</span>
          <span className="dsha-value">{regionLabel(profile, t)}</span>
        </div>
        {/* 为什么不能单独改区域、以及为什么不给自由输入，都不是标题下必须先读的话：
            收进折叠区，正文只留 pref-row 里那一行「profile 一次决定三件事」。 */}
        {moreNotes(t.moreNotes, [t.profileHintExtra, t.regionHint])}
      </section>

      <AccountPoolSection
        accounts={accounts}
        activeAccountId={status?.activeAccountId}
        rotationStrategy={status?.rotationStrategy ?? 'sequential'}
        labels={poolLabels}
        busy={busy}
        showQuota
        onLogin={() => void startLogin(profile)}
        onSetPrimary={(accountId) => void accountAction('set-primary', accountId)}
        onDelete={(accountId) => void accountAction('delete', accountId)}
        onClearCooldown={(accountId) => void accountAction('clear-cooldown', accountId)}
        onRelogin={(accountId) => void accountAction('relogin', accountId)}
        onSetStrategy={(strategy) => void setStrategy(strategy)}
        renderLoginActions={() => (
          // 标题行只放两个按钮，与 GLM / Claude 同一套写法（.dsha-grouphead 是一行
          // justify-content:space-between，第三个会被 .dsha-account-add-actions 的 flex-wrap
          // 挤到下一行——需求方实测反馈）。凭据类型已经在上面那张卡的 select 上选好，
          // 因此主按钮不需要像 GLM 那样再分国区/国际区两个。
          <div className="dsha-account-add-actions">
            <button
              className="dsha-btn dsha-btn-primary"
              disabled={busy !== null}
              aria-label={`${t.addAccount}（${profileText(profile, t)}）`}
              onClick={() => void startLogin(profile)}
            >
              {busy === `login:${profile}` ? t.authorizing : t.addAccount}
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
            <span>{t.profile}: {profileText(account.profile, t)}</span>
            <span>{t.region}: {account.region === 'cn' ? t.regionCn : t.regionIntl}</span>
            {account.accountName ? <span>{account.accountName}</span> : null}
          </>
        )}
      >
        {/* 登录流程状态是**临时内容**，因此没有自己的小标题、也不常驻版面：idle 时这一段
            整个不渲染，页面于是与 Claude 卡一样只剩「标题行 + 账号列表」。pending / complete /
            error 才出现一次，落在账号列表下面、兜底入口行的上面——紧挨着它解释的那件事。 */}
        {login !== null && login.status !== 'idle' && (
          <div className="dshsc-flow">
            {login.status === 'pending' && (
              <>
                <p className="dsha-muted">{t.loginPending}</p>
                {/* authorizeUrl 始终下发：即使 host 打开浏览器失败，用户仍能手动打开。 */}
                {login.authorizeUrl !== undefined && login.authorizeUrl !== '' && (
                  <>
                    <span className="dsha-label">{t.authorizeUrl}</span>
                    <code className="dshsc-flow-url">{login.authorizeUrl}</code>
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

            {/* 成功是把凭据换算出来并落进号池的那一刻，所以除了时间还要说清账号：
                host 保留这条终态直到下一次开流，账号池那几行却会被下一次登录刷新。
                账号之后被删掉时另说一句：号池里没有账号还宣称「已加入号池」是谎报。 */}
            {login.status === 'complete' && !authenticated && (
              <p className="dsha-muted">{t.loginCompleteNoAccount}</p>
            )}
            {login.status === 'complete' && authenticated && (
              <>
                <p className="dsha-notice">
                  {t.loginComplete}
                  {login.uid !== undefined && login.uid !== '' ? ` ${login.uid}` : ''}
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
                {/* retryable 来自契约：协议类失败永不重试，传输类与 408/429/5xx 才值得
                    自动回落。两种失败的下一步不同，因此分两句。 */}
                <div>{login.retryable === true ? t.loginRetryable : t.loginNotRetryable}</div>
              </div>
            )}

            {/* 「取消登录」是**流程控制**：它撤销的是这一次浏览器授权流程，所以与流程
                状态同级，而不是与「提交 API Key」并排——并排会让人以为它只影响粘贴。 */}
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
                ? t.adoptAdopted.replace('{profile}', profileText(adoptResult.profile ?? profile, t))
                : (adoptResult.reason === undefined
                  ? t.adoptNoAttempt
                  : `${adoptReasonText(adoptResult.reason, t)} ${t.adoptFallback}`)}
            </span>
            <button className="dsha-btn" disabled={busy !== null} onClick={clearAdoptResult}>{t.dismiss}</button>
          </div>
        )}

        {/* 兜底入口行：闲置时它只有**一行**（一句 idle 说明 + 手工粘贴开关），而不是一段
            带「登录授权」小标题的登录区。手工粘贴兜底**不删**：浏览器打不开时它是唯一能
            完成登录的地方，所以开关常驻、输入区默认收起（展开态由 useStepCodeSection 跟着
            pending / error 自动打开），需要时随时点开。

            idle 说明跟着这一行走，是因为 idle 说的是「**本进程**还没开过流」，不是「你没
            登录」：host 的 flow 是进程内变量（oauth.ts 里 let flow + resetStepCodeLogin），
            重启 host 后回到 idle，而号池里的账号还在。所以两态必须分两句：池里已经有账号
            时说「已有 N 个可用」，只有池子真的空着才说「尚未开始登录」。判据取 authenticated
            （host 由 accountCount > 0 下发，见 routes.ts）而不是登录流程的状态——后者在
            重启后已经不再描述任何登录事实。 */}
        <div className="dshsc-paste">
          {login !== null && login.status === 'idle' && (
            <span className="dsha-muted dshsc-paste-note">
              {authenticated
                ? t.loginHaveAccounts.replace('{count}', String(accounts.length))
                : t.loginIdle}
            </span>
          )}
          <button
            type="button"
            className="dsha-btn"
            aria-expanded={pasteOpen}
            aria-controls="dshsc-paste-body"
            onClick={togglePaste}
          >
            {t.manualPasteSection}
          </button>
          {pasteOpen && (
            <div className="dshsc-paste-body" id="dshsc-paste-body">
              <p className="dsha-muted">{t.manualPasteHint}</p>
              <div className="dshsc-paste-row">
                <input
                  type="password"
                  className="dsha-select"
                  aria-label={t.manualPasteSection}
                  placeholder={t.manualPastePlaceholder}
                  value={pasteValue}
                  disabled={busy !== null}
                  // 这串 Key 只活在这个受控 input 与提交那一行的局部变量里；
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

      {/* 缓存：本线路的重点。只画 token 维度，且缺数据一律画占位。 */}
      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.cacheSection}</h3>
        </div>
        {/* 标题下只留这一句：它决定用户怎么理解下面每一个数字（本机统计 ≠ 上游账单）。
            其余原句——自动前缀缓存的由来、读侧字段优先级链、为什么整页没有金额——
            一句不少地收进本组末尾的折叠区。 */}
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
                <div className={`dsha-meter ${hitRatio >= 0.9 ? 'dsha-meter-green' : 'dsha-meter-cyan'}`}>
                  <span style={{ width: `${Math.round(hitRatio * 100)}%` }} />
                </div>
              )}
              <div className="dsha-meter-meta">
                <span>{t.cacheReadTokens}: {tokenText(cache.cacheReadTokens)}</span>
                <span>{t.cacheMissedTokens}: {tokenText(cache.missedInputTokens)}</span>
                {cache.requests !== null && <span>{t.cacheRequests}: {tokenText(cache.requests)}</span>}
              </div>
            </div>
            {/* 写侧：只标注，不画条。画一条永远是 0 的进度条会把线路事实渲染成故障。 */}
            <div className="dsha-row">
              <span className="dsha-label">{t.cacheWriteNote}</span>
              <span className="dsha-value">
                {t.cacheWriteNoteValue}: {tokenText(cache.cacheWriteTokens)}
                {' · '}
                <span className="dshsc-mono">{CACHE_WRITE_NOTE}</span>
              </span>
            </div>
            <p className="dsha-muted">{t.cacheWriteNoteHint}</p>
          </div>
        )}
        {/* 请求侧能力位：默认关（与官方一致）。关着的时候把这件事说出来，比让用户去猜
            为什么没有缓存参数更诚实。 */}
        <div className="dsha-pref-row">
          <div>
            <strong>{t.cacheRequestParams}</strong>
            <p className="dsha-muted">{status?.cacheRequestParams === true ? t.cacheRequestParamsOnHint : t.cacheRequestParamsHint}</p>
          </div>
          <label className="dsha-label">
            <input
              type="checkbox"
              aria-label={t.cacheRequestParams}
              checked={status?.cacheRequestParams === true}
              disabled={busy !== null}
              onChange={(event) => void setCacheRequestParams(event.currentTarget.checked)}
            />
          </label>
        </div>
        {/* 折叠的补充说明，一句都没删：
            - cacheDesc：服务端自动前缀缓存这一段的由来；
            - 读侧字段优先级链是「实现坐标」——它解释 host 为什么读到这个数，不是用户现在
              该做什么，而且在 .dsha-row 里必然折成两行、把整卡行高拉参差，所以整串进
              这里；test/step-code-ui.test.tsx 断言的正是这串字，它仍在 textContent 里；
            - cachePricingNote：单价未文档化（四个 cost 键全是 0），因此整页没有金额；
            - cacheRequestParamsNote：打开能力位会发出未文档化的字段。 */}
        {moreNotes(t.moreNotes, [
          t.cacheDesc,
          `${t.cacheFieldOrder}: ${STEP_CODE_CACHE_READ_FIELD_ORDER.join(' → ')}`,
          t.cachePricingNote,
          t.cacheRequestParamsNote,
        ])}
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
              items={models.map((model: StepCodeModelOption) => ({
                id: model.id,
                name: model.name,
                // 契约里仍然有 hint（host 仍在生成它），但这一行**不传**：需求方实测反馈
                // 「模型行下面不需要介绍文字」。能力事实没有因此消失——它已经写在标题下
                // 那一行里（能力不从模型名推断，全部取自上游目录字段），而具体到某个
                // 模型的档位/输入模态/窗口，由默认思考档位与上下文窗口两组如实呈现。
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
            {/* 选择语义必须写在按钮旁边：清空勾选等于不过滤，而不是「一个都不可用」。
                它改变用户按下「全不选」之后对结果的预期，所以留在正文而不是折叠区。 */}
            <p className="dsha-muted">{t.enabledModelIdsSemantics}</p>
          </>
        )}
        {/* 目录怎么兜底、怎么按区域过滤：解释的是目录本身，不是勾选这一步 */}
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
              void setDefaultReasoningEffort(isStepCodeReasoningEffort(value) ? value : null)
            }}
          >
            <option value="">{t.defaultEffortModel}</option>
            {Object.entries(EFFORT_LABEL_KEYS).map(([effort, key]) => (
              <option key={effort} value={effort}>{t[key]}</option>
            ))}
          </select>
        </div>
        {/* 收敛逻辑在 host、以及「跟随各模型默认」这一项的意思，贴着 select 说清楚即可 */}
        {moreNotes(t.moreNotes, [t.defaultEffortHintExtra])}
      </section>

      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.contextWindowSection}</h3>
        </div>
        {/* 标题下只留一句：默认值来自哪里、这一栏改的是什么 */}
        <p className="dsha-muted">{t.contextWindowHint}</p>
        <ContextWindowEditor
          rows={contextModels.map((model: StepCodeModelOption) => ({
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
          metaClassName="dshsc-model-meta"
          onDraftChange={updateContextDraft}
          onCommit={(id) => void saveContextWindow(id)}
          onReset={(id) => void resetContextWindow(id)}
          onResetAll={() => void resetAllContextWindows()}
        />
        {moreNotes(t.moreNotes, [t.contextWindowHintExtra])}
      </section>

      {/* 额度：两代套餐形状分别渲染，绝不揉成一份「看起来一样」的进度条。 */}
      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.quotaSection}</h3>
          <button className="dsha-btn" disabled={busy !== null || !authenticated} onClick={() => void refreshQuota()}>
            {busy === 'quota' ? t.quotaRefreshing : t.quotaRefresh}
          </button>
        </div>
        {/* 标题下只留这一句（来自共享账号池文案，本文件不改）：额度数字跟着账号卡片走。
            它是用户理解「为什么这里没有进度条」的关键，所以必须是正文里留下的那一句。 */}
        <p className="dsha-muted">{poolLabels.quotaFactsScope}</p>
        {status?.quotaRefreshing === true && <p className="dsha-notice">{t.quotaRefreshingNote}</p>}
        {status?.quotaError !== undefined && status.quotaError !== null && status.quotaError !== '' && (
          <p className="dsha-notice">{`${t.quotaErrorLabel}: ${status.quotaError}`}</p>
        )}

        {!authenticated ? (
          <div className="dsha-empty">{t.quotaSignedOut}</div>
        ) : quota === null ? (
          <div className="dsha-empty">{busy === 'quota' ? t.quotaRefreshing : t.quotaEmpty}</div>
        ) : (
          <div className="dsha-quota-card">
            {/* 头部两件事：套餐名 + 形态（与 GLM 卡同款 .dsha-quota-title）。形态画在快照
                分支里：认不出两代形状时这里就说「认不出」，下面一个窗口与一个桶都不画。 */}
            <div className="dsha-quota-title">
              <strong>{quota.planName !== null && quota.planName !== '' ? quota.planName : t.quotaPlan}</strong>
              <span>{quotaKindText(quota.kind, t)}</span>
            </div>
            {/* 其余事实走紧凑网格：一格一件事、行高一致，而不是一行一个标签占满整宽。 */}
            <div className="dshsc-fact-grid">
              <div className="dshsc-fact">
                <span>{t.quotaRenews}</span>
                <span>{formatDate(quota.renewsAt)}</span>
              </div>
              <div className="dshsc-fact">
                <span>{t.quotaReadAt}</span>
                <span>{formatDate(quota.fetchedAt)}</span>
              </div>
              <div className="dshsc-fact">
                <span>{t.quotaRegion}</span>
                <span>{quota.region === 'cn' ? t.regionCn : t.regionIntl}</span>
              </div>
            </div>

            {quota.kind === 'windowed' && quota.windows.length > 0 && (
              <div className="dshsc-quota-list">
                {quota.windows.map((window, index) => quotaWindowRow(window, index, t))}
              </div>
            )}
            {quota.kind === 'windowed' && quota.windows.length === 0 && (
              <div className="dsha-empty">{t.quotaEmpty}</div>
            )}

            {quota.kind === 'credit' && quota.creditBuckets.length > 0 && (
              <div className="dshsc-quota-list">
                {quota.creditBuckets.map((bucket, index) => (
                  <div className="dshsc-bucket" key={`bucket:${index}`}>
                    <span className="dsha-label">{`${t.quotaWindowCredit} #${index + 1}`}</span>
                    <span className="dsha-value">
                      {t.quotaBucketRemaining}: {tokenText(bucket.remaining)} / {tokenText(bucket.total)}
                    </span>
                    {bucket.expiresAt !== null && (
                      <span className="dshsc-quota-meta">
                        {t.quotaBucketExpires}: {formatDate(bucket.expiresAt)}
                      </span>
                    )}
                    {bucket.resetsAt !== null && (
                      <span className="dshsc-quota-meta">
                        {t.quotaBucketResets}: {formatDate(bucket.resetsAt)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {quota.kind === 'credit' && quota.creditBuckets.length === 0 && (
              <div className="dsha-empty">{t.quotaEmpty}</div>
            )}

            {quota.kind === 'unknown' && (
              <div className="dsha-empty">{quotaKindText('unknown', t)}</div>
            )}
          </div>
        )}
        {/* 折叠的补充说明，一句都没删：
            - quotaDesc：数据来自开发者中心（非公开接口）这一整段来源与风险说明；
            - quotaWindowNames：窗口名按窗口长度本地化，不在本页硬编码；
            - quotaKindHint：两代套餐按载荷形状判定，认不出时只说「认不出」；
            - plan_family 与端点路径：快照的机器坐标，只对排障有意义。 */}
        {moreNotes(t.moreNotes, [
          t.quotaDesc,
          t.quotaWindowNames,
          t.quotaKindHint,
          quotaMachineFactsText(quota, t),
        ])}
      </section>

      {/* 额度凭据：非公开接口，账号密码或 Token 都要过手。这里显示的只是「有没有、
          从哪来」；凭据本身只存在于 host，没有任何接口能把它读回前端。 */}
      <section className="dsha-group">
        <div className="dsha-grouphead">
          <h3>{t.quotaCredentialSection}</h3>
        </div>
        {/* 状态区：有没有 / 来源 / 账号 / 过期各占一行 .dsha-row，「清除」收在 .dsha-actions
            里右对齐（共享类本来就是 flex-end），不再单独占一整行宽按钮。 */}
        {quotaCredential === null || quotaCredential.hasCredential !== true ? (
          <div className="dsha-empty">{t.quotaCredentialNone}</div>
        ) : (
          <>
            <div className="dsha-row">
              <span className="dsha-label">{t.quotaCredentialSource}</span>
              <span className="dsha-value">{quotaCredentialSourceText(quotaCredential.source, t)}</span>
            </div>
            {quotaCredential.account !== undefined && quotaCredential.account !== null && quotaCredential.account !== '' && (
              <div className="dsha-row">
                <span className="dsha-label">{t.quotaCredentialAccount}</span>
                <span className="dsha-value">{quotaCredential.account}</span>
              </div>
            )}
            {quotaCredential.expiresAt !== undefined && quotaCredential.expiresAt !== null && (
              <div className="dsha-row">
                <span className="dsha-label">{t.quotaCredentialExpires}</span>
                <span className="dsha-value">{formatDate(quotaCredential.expiresAt)}</span>
              </div>
            )}
            {quotaCredential.error !== undefined && quotaCredential.error !== null && quotaCredential.error !== '' && (
              <div className="dsha-notice">{`${t.quotaCredentialError}: ${quotaCredential.error}`}</div>
            )}
            <div className="dsha-actions">
              <button className="dsha-btn" disabled={busy !== null} onClick={() => void clearQuotaCredential()}>
                {busy === 'quota-credential:clear' ? t.quotaCredentialClearing : t.quotaCredentialClear}
              </button>
            </div>
          </>
        )}

        {/* 两个获取方式各一个子块：标题一行 + 一个网格输入行。输入框复用 .dsha-select、
            按钮复用 .dsha-btn / .dsha-btn-primary，本文件不新增任何按钮样式；网格保证
            输入框与按钮等高、同一基线、不会在窄屏错位换行。 */}
        <div className="dshsc-cred-block">
          <strong className="dshsc-cred-title">{t.quotaCredentialPasswordSection}</strong>
          <div className="dshsc-cred-grid">
            <input
              type="text"
              className="dsha-select"
              aria-label={t.quotaCredentialAccount}
              placeholder={t.quotaCredentialAccountPlaceholder}
              value={quotaAccount}
              disabled={busy !== null}
              autoComplete="off"
              onChange={(event) => setQuotaAccount(event.currentTarget.value)}
            />
            <input
              type="password"
              className="dsha-select"
              aria-label={t.quotaCredentialPasswordPlaceholder}
              placeholder={t.quotaCredentialPasswordPlaceholder}
              value={quotaPassword}
              disabled={busy !== null}
              autoComplete="new-password"
              onChange={(event) => setQuotaPassword(event.currentTarget.value)}
            />
            <button
              className="dsha-btn dsha-btn-primary"
              disabled={busy !== null || quotaAccount.trim() === '' || quotaPassword === ''}
              onClick={() => void submitQuotaPassword()}
            >
              {busy === 'quota-credential:password' ? t.quotaCredentialPasswordSubmitting : t.quotaCredentialPasswordSubmit}
            </button>
          </div>
        </div>

        {/* 手动粘贴是同一个操作（换一种拿凭据的办法），所以与上一块同款，只有一个输入框：
            网格退化成 minmax(0,1fr) auto，按钮仍然右对齐等高。 */}
        <div className="dshsc-cred-block">
          <strong className="dshsc-cred-title">{t.quotaCredentialManualSection}</strong>
          <div className="dshsc-cred-grid dshsc-cred-grid-narrow">
            <input
              type="password"
              className="dsha-select"
              aria-label={t.quotaCredentialTokenPlaceholder}
              placeholder={t.quotaCredentialTokenPlaceholder}
              value={quotaToken}
              disabled={busy !== null}
              autoComplete="off"
              onChange={(event) => setQuotaToken(event.currentTarget.value)}
            />
            <button
              className="dsha-btn"
              disabled={busy !== null || quotaToken === ''}
              onClick={() => void submitQuotaToken()}
            >
              {busy === 'quota-credential:manual' ? t.quotaCredentialTokenSubmitting : t.quotaCredentialTokenSubmit}
            </button>
          </div>
        </div>

        {/* 原先的 quotaCredentialHint 与 quotaCredentialRisk 合成这一句：两句说的是同一条
            边界（凭据只存在于 host、只在点击提交的那一刻过一趟请求体），所以它属于整段
            而不是某一个操作块——放在最下面，不夹在两个输入块中间。 */}
        <p className="dsha-muted">{t.quotaCredentialFoot}</p>
      </section>

      {error !== null && (
        <div className="dsha-error">
          <div>{error}</div>
        </div>
      )}
    </div>
  )
}

