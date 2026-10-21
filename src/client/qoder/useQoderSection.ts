/**
 * Qoder（订阅）设置卡片的状态、副作用与动作。
 *
 * 与 GLM / Step Code 同样的分工：这个文件是行为，QoderSection.tsx
 * 是渲染，两者之间只通过下面这一个具名结构交接，卡片因此保持「只画」的状态。
 *
 * 一条设计约束贯穿全文件：**能力与文案都不在本文件重算**。模型行的一句话描述来自
 * 契约里的 QoderModelOption.hint（host 由运行时发现的目录生成），客户端一旦自己
 * 推断能力，就等于把「能力不得从模型名推断」这条规则重新打开。
 *
 * 凭据边界：PAT 只存在于 submitPaste 的局部变量与受控输入框里，提交时随 POST 体
 * 一次性交给 host，随即被清空。它不进 URL、不写日志、没有任何持久化写入。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import {
  isQoderRegion,
  type QoderAccountSummaryDto,
  type QoderAdoptResultDto,
  type QoderConnectionDto,
  type QoderLoginFlowStatus,
  type QoderModelOption,
  type QoderReasoningEffort,
  type QoderRegion,
  type QoderStatusDto,
} from '../../shared/qoder-contracts.ts'
import type { AccountPoolLabels } from '../common/AccountPoolSection.tsx'
import { contextDraftsFor } from '../common/ContextWindowEditor.tsx'
import { formatCapacity, parsePositiveCapacity } from '../common/format.ts'
import { createQuotaFollowUp, type QuotaFollowUp } from '../common/quota-follow-up.ts'
import { get, messageOf, post } from './api.ts'
import { zh } from './locales.ts'

/** 登录状态机的轮询节奏。真实超时与间隔由 host 拥有，卡片只是跟随。 */
const LOGIN_POLL_INTERVAL_MS = 2_000

/** 卡片渲染的键。与兄弟卡片一样用自己的字典。 */
export type Translate = (key: keyof typeof zh) => string

/** 本卡片的字典；身份稳定，依赖它的 effect 才不会每次渲染重建。 */
export const fallbackTranslate: Translate = (key) => zh[key]

/**
 * 共享账号池卡片需要的标签集，按本卡片的字典逐键查出来。
 *
 * 从共享标签对象自身的键推导，因此共享卡片新增一个标签而这里漏掉时是编译错误，
 * 而不是页面上少一句话。
 */
function accountPoolLabelsFor(t: Translate): AccountPoolLabels {
  return {
    accountPool: t('accountPool'),
    addAccount: t('addAccount'),
    accountCount: t('accountCount'),
    primaryAccount: t('primaryAccount'),
    activeAccount: t('activeAccount'),
    setPrimary: t('setPrimary'),
    deleteAccount: t('deleteAccount'),
    cooling: t('cooling'),
    cooldownLeft: t('cooldownLeft'),
    cooldownRemaining: t('cooldownRemaining'),
    cooldownRemainingSeconds: t('cooldownRemainingSeconds'),
    clearCooldown: t('clearCooldown'),
    needsRelogin: t('needsRelogin'),
    relogin: t('relogin'),
    rotationStrategy: t('rotationStrategy'),
    strategySequential: t('strategySequential'),
    strategyRoundRobin: t('strategyRoundRobin'),
    strategySticky: t('strategySticky'),
    noAccounts: t('noAccounts'),
    email: t('email'),
    expires: t('expires'),
    lastUsed: t('lastUsed'),
    accountId: t('accountId'),
    accountQuota: t('accountQuota'),
    quotaNone: t('quotaNone'),
    quotaSnapshot: t('quotaSnapshot'),
    quotaResets: t('quotaResets'),
    quotaExhausted: t('quotaExhausted'),
    quotaWindow: t('quotaWindow'),
    quotaUsed: t('quotaUsed'),
    quotaFactsScope: t('quotaFactsScope'),
    composerLabel: t('composerLabel'),
  }
}

/**
 * host 下发的号池行 → 契约里带区域与来源的那一行。
 *
 * 冻结契约写的是 accounts?: PoolAccountSummaryDto[]（QoderStatusDto 继承的是
 * Partial<AccountPoolStatusDto>），元素类型是最小的 PoolAccountSummaryDto，
 * QoderAccountSummaryDto 是它的**扩展**而不是它的元素类型；契约已冻结，所以这里在
 * 客户端补齐：region / origin 等 host 确实下发的字段原样取，只有缺失时才回落到当前
 * 选择的区域。
 */
function qoderAccounts(status: QoderStatusDto | null, fallbackRegion: QoderRegion): QoderAccountSummaryDto[] {
  type Extra = Partial<Pick<QoderAccountSummaryDto, 'region' | 'origin' | 'accountName'>>
  return (status?.accounts ?? []).map((account) => {
    const extra = account as typeof account & Extra
    const region = isQoderRegion(extra.region) ? extra.region : fallbackRegion
    return {
      ...account,
      region,
      origin: extra.origin === 'device' || extra.origin === 'pat' || extra.origin === 'adopt' ? extra.origin : 'device',
      ...(extra.accountName === undefined ? {} : { accountName: extra.accountName }),
    }
  })
}

/**
 * 本线路的缓存统计（本机自报，token 维度）。
 *
 * 三个数都是 token，没有金额：Qoder 订阅没有公开的 token 单价（计划 §5），
 * 拿编的费率算出「省了 N 元」是撒谎。
 */
export interface QoderCacheStats {
  cacheReadTokens: number
  missedInputTokens: number
  cacheWriteTokens: number
  /** 这些数字覆盖了几次请求；没有它就不知道样本有多大。 */
  requests: number | null
}

/** 一个有限数字，或 null。host 可能下发字符串或 null，所以逐个校验而不是直接断言。 */
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 从一份 status 里取缓存统计；取不到返回 null。
 *
 * 返回 null 而不是零值对象，是因为「上游没报」与「报了个 0」在卡片上必须长得不一样：
 * 前者显示占位符，后者显示真实的 0%。
 */
export function readCacheStats(status: QoderStatusDto | null): QoderCacheStats | null {
  const carrier = status?.cacheStats
  if (carrier === undefined || carrier === null) return null
  const read = finiteNumber(carrier.cacheReadTokens)
  const missed = finiteNumber(carrier.missedInputTokens)
  if (read === null || missed === null) return null
  return {
    cacheReadTokens: read,
    missedInputTokens: missed,
    cacheWriteTokens: finiteNumber(carrier.cacheWriteTokens) ?? 0,
    requests: finiteNumber(carrier.requests),
  }
}

/**
 * 缓存命中率 = 缓存读入 /（缓存读入 + 未命中输入）。
 *
 * 分母为 0 时返回 **null**，卡片据此画占位符：把「没有样本」写成 0% 是谎报。
 */
export function cacheHitRatio(stats: QoderCacheStats | null): number | null {
  if (stats === null) return null
  const denominator = stats.cacheReadTokens + stats.missedInputTokens
  if (!Number.isFinite(denominator) || denominator <= 0) return null
  return stats.cacheReadTokens / denominator
}

export interface QoderSectionProps {
  onModelChange?: () => void
}

/** 账号卡片上的一个动作。 */
export type QoderAccountAction = 'set-primary' | 'delete' | 'clear-cooldown' | 'relogin'

/** 视图可以消费的全部内容，按「会变的事实 / 从答案派生的 / 能触发的」分组。 */
export interface QoderSectionView {
  state: {
    status: QoderStatusDto | null
    loading: boolean
    busy: string | null
    error: string | null
    connection: QoderConnectionDto | null
    adoptResult: QoderAdoptResultDto | null
    /** 手工粘贴的 PAT；提交后立即清空，只在这一行的受控输入里存在。 */
    pasteValue: string
    /** 下一次浏览器登录 / PAT 粘贴按哪个区域发起。 */
    region: QoderRegion
    /** 手工粘贴兜底是否展开（没有进行中的流程时默认收起）。 */
    pasteOpen: boolean
    contextDrafts: Record<string, string>
    savingModel: string | null
  }
  derived: {
    accounts: QoderAccountSummaryDto[]
    models: QoderModelOption[]
    /** 上下文窗口编辑器的行：只有勾选了的模型才有可覆盖的窗口。 */
    contextModels: QoderModelOption[]
    overrideCount: number
    login: QoderLoginFlowStatus | null
    quota: QoderStatusDto['quota']
    authenticated: boolean
    poolLabels: AccountPoolLabels
    /** 缓存统计；host 未下发时为 null（卡片显示占位而不是 0%）。 */
    cache: QoderCacheStats | null
    /** 缓存命中率；没有样本时为 null。 */
    cacheHitRatio: number | null
  }
  actions: {
    setRegion(region: QoderRegion): void
    login(region: QoderRegion): Promise<void>
    cancelLogin(): Promise<void>
    submitPaste(): Promise<void>
    setPasteValue(value: string): void
    togglePaste(): void
    adopt(): Promise<void>
    clearAdoptResult(): void
    accountAction(action: QoderAccountAction, accountId: string): Promise<void>
    setStrategy(strategy: AccountRotationStrategy): Promise<void>
    toggleModel(modelId: string, enabled: boolean): void
    setAllModels(enabled: boolean): void
    saveContextWindow(modelId: string): Promise<void>
    resetContextWindow(modelId: string): Promise<void>
    resetAllContextWindows(): Promise<void>
    updateContextDraft(modelId: string, draft: string): void
    setDefaultReasoningEffort(effort: QoderReasoningEffort | null): Promise<void>
    refreshQuota(): Promise<void>
    refreshCatalog(): Promise<void>
    testConnection(): Promise<void>
  }
}

export function useQoderSection({ onModelChange }: QoderSectionProps = {}): QoderSectionView {
  const t: Translate = fallbackTranslate
  const [status, setStatus] = useState<QoderStatusDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<QoderConnectionDto | null>(null)
  const [adoptResult, setAdoptResult] = useState<QoderAdoptResultDto | null>(null)
  const [pasteValue, setPasteValue] = useState('')
  // 手工粘贴兜底的展开态。功能不删（浏览器打不开时它是唯一出路），只是没有进行中
  // 的流程时不再常年占版面；流程一开始（pending / error）自动展开，结束后自动收起。
  const [pasteOpen, setPasteOpen] = useState(false)
  const [region, setRegionState] = useState<QoderRegion>('global')
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)

  // 用户是否亲手选过区域。没选过时跟随 host 下发的 status.region，选过之后
  // 不再被 60 秒一次的静默刷新改回去。
  const regionTouched = useRef(false)
  // 上游在应答背后刷新配额时的补读，一次只挂一个。
  const quotaFollowUp = useRef<QuotaFollowUp | undefined>(undefined)
  /**
   * 首屏那次目录补拉是否已经试过。**一次就够，且只试一次**。
   *
   * 用 ref 而不是 state：这个判断要在异步回调里立刻生效，state 的下一次渲染
   * 之前读到的还是旧值，那一拍足以让 60 秒轮询与首屏各拉一次。
   *
   * 为什么需要它而不是靠 catalogRefreshing：那个字段是**当下这一刻**的事实，
   * 一次失败的补拉之后它仍会是 true（缓存依然是空的），没有这个 ref 就会变成
   * 「每一拍都补拉一次」——把一次静默优化做成了对上游的压测。
   */
  const catalogPullAttempted = useRef(false)

  /**
   * 静默补拉一次模型目录。
   *
   * host 的 GET /status 只读缓存（缓存为空时选择器显示随包兜底表），真实目录
   * 的刷新排在应答背后——**这是对的**，但它意味着首屏拿到的很可能是兜底表，
   * 而要等 60 秒轮询才会被顶掉。这里补一次，让用户打开页面就看到真实目录。
   *
   * 与手动「刷新目录」按钮的唯一区别是**没有** busy 与 error：这条路径没有
   * 用户在看，失败时选择器继续用兜底表就够了（兜底表存在的理由就是这个）。
   * 失败也不重试：重试的责任在 60 秒轮询与用户手上的按钮。
   */
  const pullCatalogQuietly = useCallback(async (): Promise<void> => {
    if (catalogPullAttempted.current) return
    catalogPullAttempted.current = true
    try {
      const next = await post<QoderStatusDto>('/catalog/refresh', {})
      setStatus(next)
      setContextDrafts(contextDraftsFor(next))
    } catch {
      // 静默：目录拿不到时选择器继续用兜底表，卡片不因此报错。
    }
  }, [])

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try {
      const next = await get<QoderStatusDto>('/status')
      setStatus(next)
      setContextDrafts(contextDraftsFor(next))
      if (!regionTouched.current && isQoderRegion(next.region)) setRegionState(next.region)
      quotaFollowUp.current ??= createQuotaFollowUp()
      quotaFollowUp.current.observe(next.quotaRefreshing === true, () => { void loadStatus(true) })
      // 首屏（以及任何一次）拿到「目录正在/将要刷新」= 你看到的还是兜底表，
      // 补拉一次把它换掉。catalogPullAttempted 保证这在整个挂载期内只发生一次，
      // 所以这里不需要判断是不是第一次渲染。
      if (next.catalogRefreshing === true) void pullCatalogQuietly()
    } catch (cause) {
      if (!quiet) setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [pullCatalogQuietly])

  useEffect(() => {
    void loadStatus()
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') void loadStatus(true)
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const timer = window.setInterval(refreshWhenVisible, 60_000)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      quotaFollowUp.current?.cancel()
    }
  }, [loadStatus])

  // 浏览器授权不是卡片能控制的东西，流程跑在 host 上，卡片只跟随。
  const loginStatus = status?.login?.status
  useEffect(() => {
    if (loginStatus !== 'pending') return
    let stopped = false
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const poll = await get<QoderLoginFlowStatus>('/login/status')
          if (stopped) return
          if (poll.status === 'complete') {
            setPasteValue('')
            await loadStatus()
            onModelChange?.()
          } else if (poll.status === 'error') {
            setError(poll.error ?? t('loginError'))
          }
        } catch {
          // 轮询失败是暂时性的：5xx 与畸形应答都按 pending 处理，下一拍重试。
        }
      })()
    }, LOGIN_POLL_INTERVAL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [loginStatus, loadStatus, onModelChange, t])

  // 兜底框跟着登录流程的阶段走：pending / error 是用户最需要一个手动出口的两个阶段。
  useEffect(() => {
    setPasteOpen(loginStatus === 'pending' || loginStatus === 'error')
  }, [loginStatus])

  const setRegion = useCallback((next: QoderRegion) => {
    regionTouched.current = true
    setRegionState(next)
  }, [])

  const login = async (loginRegion: QoderRegion): Promise<void> => {
    try {
      setBusy('login:' + loginRegion)
      setError(null)
      setConnection(null)
      setPasteValue('')
      const flow = await post<QoderLoginFlowStatus>('/login/start', { region: loginRegion })
      await loadStatus(true)
      // 卡片是唯一打开浏览器的地方；弹窗被拦下也不要紧，下面渲染的就是同一个链接。
      if (flow.authorizeUrl !== undefined && flow.authorizeUrl !== '') {
        try {
          window.open(flow.authorizeUrl, '_blank', 'noopener,noreferrer')
        } catch {
          // 无 window.open 的宿主（如某些内嵌壳）忽略即可，链接仍然可点。
        }
      }
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const cancelLogin = async (): Promise<void> => {
    try {
      setBusy('login:cancel')
      setError(null)
      await post<QoderLoginFlowStatus>('/login/cancel', {})
      await loadStatus(true)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const submitPaste = async (): Promise<void> => {
    const token = pasteValue.trim()
    if (token === '') {
      setError(t('manualPasteEmpty'))
      return
    }
    try {
      setBusy('login-manual')
      setError(null)
      // 这条路由回的是整份 status：兑换成功会写入凭据，账号卡、模型与配额在返回时
      // 就已经过期了。请求体带凭据，刻意不进冻结契约。
      setStatus(await post<QoderStatusDto>('/login/manual', { region, token }))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      // 无论成败都不再保留这串 PAT：它已经提交过，或已经被拒了。
      setPasteValue('')
      setBusy(null)
    }
  }

  const adopt = async (): Promise<void> => {
    try {
      setBusy('adopt')
      setError(null)
      // adopt 不带区域：host 对两区各探一次 userinfo（区域属于凭据，不猜）。
      const result = await post<QoderAdoptResultDto>('/adopt', {})
      setAdoptResult(result)
      // adopt 只省一次登录：成功与否都要重新读状态，让账号卡与模型立刻反映真实凭据。
      await loadStatus(true)
      if (result.adopted) onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const accountAction = async (action: QoderAccountAction, accountId: string): Promise<void> => {
    try {
      setBusy('account:' + action + ':' + accountId)
      setError(null)
      setStatus(await post<QoderStatusDto>('/accounts', { action, accountId }))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const setStrategy = async (strategy: AccountRotationStrategy): Promise<void> => {
    try {
      setBusy('strategy')
      setError(null)
      setStatus(await post<QoderStatusDto>('/accounts', { action: 'strategy', strategy }))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  /**
   * 一个模型勾选补丁；host 回整份新状态，卡片因此不必猜哪些 id 最终生效。
   *
   * 语义是**三态**：`null` = 不过滤（全部可用），`[]` = 用户明确全关，
   * 非空 = 白名单。所以「全不选」提交的是空数组，它真的意味着**一个模型都不可用**；
   * 要恢复全部请点「全选」（提交目录里的全部 id）。
   */
  const applyEnabledModels = async (enabledModelIds: string[] | null): Promise<void> => {
    try {
      setError(null)
      const updated = await post<QoderStatusDto>('/settings', { enabledModelIds })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const toggleModel = (modelId: string, enabled: boolean): void => {
    if (status === null) return
    // 当前是「不过滤」（null）时先物化成目录里的全部 id：只关掉一个模型也得写成
    // 显式白名单，否则 null 会被 host 读成「仍然全开」，这一勾就白点了。
    const current = status.models.filter((model) => model.enabled).map((model) => model.id)
    const next = enabled ? [...new Set([...current, modelId])] : current.filter((id) => id !== modelId)
    void applyEnabledModels(next)
  }

  const setAllModels = (enabled: boolean): void => {
    if (status === null || status.models.length === 0) return
    // 「全不选」提交空数组 = 全部不可用（不是「回到不过滤」，那是三态之前的老语义）；
    // 「全选」提交全部 id = 显式白名单，等价于不过滤但读得出来是用户按的。
    void applyEnabledModels(enabled ? status.models.map((model) => model.id) : [])
  }

  const saveContextWindow = async (modelId: string): Promise<void> => {
    const raw = contextDrafts[modelId] ?? ''
    const parsed = parsePositiveCapacity(raw)
    if (parsed === null) {
      setError(t('invalidCapacity').replace('{value}', raw))
      return
    }
    try {
      setSavingModel(modelId)
      setError(null)
      setStatus(await post<QoderStatusDto>('/settings', { contextWindowOverrides: { [modelId]: parsed } }))
      setContextDrafts((previous) => ({ ...previous, [modelId]: formatCapacity(parsed) }))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSavingModel(null)
    }
  }

  const resetContextWindow = async (modelId: string): Promise<void> => {
    try {
      setSavingModel(modelId)
      setError(null)
      // null 是「删掉这条覆盖」的线上写法，host 删键后目录默认值重新生效。
      const updated = await post<QoderStatusDto>('/settings', { contextWindowOverrides: { [modelId]: null } })
      setStatus(updated)
      const model = updated.models.find((entry) => entry.id === modelId)
      if (model !== undefined) {
        setContextDrafts((previous) => ({ ...previous, [modelId]: formatCapacity(model.defaultContextWindow) }))
      }
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSavingModel(null)
    }
  }

  const resetAllContextWindows = async (): Promise<void> => {
    const ids = Object.keys(status?.contextWindowOverrides ?? {})
    if (ids.length === 0) return
    try {
      setError(null)
      const updated = await post<QoderStatusDto>('/settings', {
        contextWindowOverrides: Object.fromEntries(ids.map((id) => [id, null])),
      })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const setDefaultReasoningEffort = async (effort: QoderReasoningEffort | null): Promise<void> => {
    try {
      setBusy('effort')
      setError(null)
      setStatus(await post<QoderStatusDto>('/settings', { defaultReasoningEffort: effort }))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const refreshQuota = async (): Promise<void> => {
    try {
      setBusy('quota')
      setError(null)
      setStatus(await post<QoderStatusDto>('/quota', {}))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const refreshCatalog = async (): Promise<void> => {
    try {
      setBusy('catalog')
      setError(null)
      setStatus(await post<QoderStatusDto>('/catalog/refresh', {}))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const testConnection = async (): Promise<void> => {
    try {
      setBusy('connection')
      setError(null)
      setConnection(await post<QoderConnectionDto>('/connection/test', {}))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const accounts = qoderAccounts(status, region)
  const models = status?.models ?? []
  // 未勾选的模型不会被提供给会话，为它准备上下文窗口设置只是死设置。
  const contextModels = models.filter((model) => model.enabled)
  const cache = readCacheStats(status)

  return {
    state: {
      status,
      loading,
      busy,
      error,
      connection,
      adoptResult,
      pasteValue,
      region,
      pasteOpen,
      contextDrafts,
      savingModel,
    },
    derived: {
      accounts,
      models,
      contextModels,
      overrideCount: Object.keys(status?.contextWindowOverrides ?? {}).length,
      login: status?.login ?? null,
      quota: status?.quota ?? null,
      authenticated: status?.authenticated === true,
      poolLabels: accountPoolLabelsFor(t),
      cache,
      cacheHitRatio: cacheHitRatio(cache),
    },
    actions: {
      setRegion,
      login,
      cancelLogin,
      submitPaste,
      setPasteValue,
      togglePaste: () => setPasteOpen((previous) => !previous),
      adopt,
      clearAdoptResult: () => setAdoptResult(null),
      accountAction,
      setStrategy,
      toggleModel,
      setAllModels,
      saveContextWindow,
      resetContextWindow,
      resetAllContextWindows,
      updateContextDraft: (modelId: string, draft: string) => {
        setContextDrafts((previous) => ({ ...previous, [modelId]: draft }))
      },
      setDefaultReasoningEffort,
      refreshQuota,
      refreshCatalog,
      testConnection,
    },
  }
}
