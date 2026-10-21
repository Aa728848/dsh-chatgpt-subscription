/**
 * Step Code（Step Plan 订阅）设置卡片的状态、副作用与动作。
 *
 * 与 GLM / MiniMax Code 同样的分工：这个文件是行为，StepCodeSection.tsx
 * 是渲染，两者之间只通过下面这一个具名结构交接，卡片因此保持「只画」的状态。
 *
 * 一条设计约束贯穿全文件：**能力与文案都不在本文件重算**。模型行的一句话描述来自
 * 契约里的 StepCodeModelOption.hint（host 由运行时发现的目录生成），图片输入与思考
 * 档位来自同一条记录的字段，客户端一旦自己推断能力，就等于把「能力不得从模型名推断」
 * 这条规则重新打开。
 *
 * 凭据边界：密码与 Oasis-Token 只存在于下面三个 setQuota* / submit* 的**局部变量与
 * 受控输入框**里，提交时随 POST 体一次性交给 host，随即被清空。它们不进 URL、不写日志、
 * 没有任何持久化写入，也没有任何读取它们的动作。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import {
  STEP_CODE_CACHE_WRITE_NOTE,
  isStepCodeProfile,
  stepCodeRegionOf,
  type StepCodeAccountSummaryDto,
  type StepCodeAdoptResultDto,
  type StepCodeConnectionDto,
  type StepCodeLoginFlowStatus,
  type StepCodeModelOption,
  type StepCodeProfile,
  type StepCodeQuotaCredentialStatusDto,
  type StepCodeQuotaSnapshotDto,
  type StepCodeReasoningEffort,
  type StepCodeStatusDto,
} from '../../shared/step-code-contracts.ts'
import type { AccountPoolLabels } from '../common/AccountPoolSection.tsx'
import { contextDraftsFor } from '../common/ContextWindowEditor.tsx'
import { formatCapacity, parsePositiveCapacity } from '../common/format.ts'
import { createQuotaFollowUp, type QuotaFollowUp } from '../common/quota-follow-up.ts'
import { get, messageOf, post } from './api.ts'
import { zh } from './locales.ts'

/** 登录状态机的轮询节奏。真实超时与间隔由 host 拥有，卡片只是跟随。 */
const LOGIN_POLL_INTERVAL_MS = 2_000

/** 卡片渲染的键。与兄弟卡片一样用自己的字典，不复用 hub 挂在 settings.section 上的座位。 */
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
 * host 下发的号池行 → 契约里带 profile 与区域的那一行。
 *
 * 冻结契约写的是 `accounts?: PoolAccountSummaryDto[]`（StepCodeStatusDto 继承的是
 * Partial<AccountPoolStatusDto>），元素类型是最小的 PoolAccountSummaryDto，
 * StepCodeAccountSummaryDto 是它的**扩展**而不是它的元素类型；契约已冻结，所以这里在
 * 客户端补齐：profile / region 等 host 确实下发的字段原样取，只有缺失时才回落到当前
 * 选择的 profile 与它唯一决定的区域。
 */
function stepCodeAccounts(status: StepCodeStatusDto | null, fallbackProfile: StepCodeProfile): StepCodeAccountSummaryDto[] {
  type Extra = Partial<Pick<StepCodeAccountSummaryDto, 'profile' | 'region' | 'accountName'>>
  return (status?.accounts ?? []).map((account) => {
    const extra = account as typeof account & Extra
    const profile = isStepCodeProfile(extra.profile) ? extra.profile : fallbackProfile
    return {
      ...account,
      profile,
      // 区域是凭据的属性（契约 stepCodeRegionOf）：host 没给的那一格由 profile 推出，
      // 不让用户在这一层挑一个与 profile 不一致的区域。
      region: extra.region === 'cn' || extra.region === 'intl' ? extra.region : stepCodeRegionOf(profile),
      ...(extra.accountName === undefined ? {} : { accountName: extra.accountName }),
    }
  })
}

/**
 * 本线路的缓存统计（本机自报，token 维度）。
 *
 * 契约没有把它写进 StepCodeStatusDto —— 冻结时缓存用量仍在 mapper 与 cache-stats 侧，
 * 所以这里声明一个**只读**的形状，并由 readCacheStats 在运行时从 status 上取：host
 * 一旦下发，卡片直接有数据；还没下发时读侧显示占位而不是 0%。
 *
 * 三个数都是 token，没有金额：官方模型表里四个 cost 键全是 0（STEP_CODE_PRICING_STATUS
 * = 'undocumented-zero'），拿 0 当单价算出「省了 0 元」是正确但无用。
 */
export interface StepCodeCacheStats {
  /** 本进程累计的缓存读入 token（字段口径见 STEP_CODE_CACHE_READ_FIELD_ORDER）。 */
  cacheReadTokens: number
  /** 本进程累计的**未命中**输入 token（prompt 减去缓存读入的部分）。 */
  missedInputTokens: number
  /** 写侧 token，在本线路恒为 0；卡片按 STEP_CODE_CACHE_WRITE_NOTE 标注而不画条。 */
  cacheWriteTokens: number
  /** 这些数字覆盖了几次请求；没有它就不知道样本有多大。 */
  requests: number | null
}

/** status 上可能承载缓存统计的两个键名（先到先用）。 */
const CACHE_STATS_KEYS = ['cacheStats', 'cache'] as const

/** 一个有限数字，或 null。host 可能下发字符串或 null，所以逐个校验而不是直接断言。 */
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 一份候选对象里「缓存读入」与「未命中输入」两个数，或 null。
 *
 * 三种命名都收，因为它们指的是同一对量：host 侧 cache-stats 的聚合用
 * cacheReadTokens + inputTokens（inputTokens 在那条线路上就是 uncached prompt
 * tokens），兄弟线路 Kimi 用 cachedTokens / freshTokens，而本文件对外叫
 * cacheReadTokens / missedInputTokens。折成同一对并不引入任何新的解释——
 * 命中率的算法仍是下面那一个公式，读侧的字段优先级则由
 * STEP_CODE_CACHE_READ_FIELD_ORDER 在 host 侧决定。
 */
function cacheTokenPair(value: unknown): { read: number; missed: number } | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const read = finiteNumber(candidate.cacheReadTokens) ?? finiteNumber(candidate.cachedTokens)
  const missed = finiteNumber(candidate.missedInputTokens)
    ?? finiteNumber(candidate.freshTokens)
    ?? finiteNumber(candidate.inputTokens)
  return read === null || missed === null ? null : { read, missed }
}

/**
 * 从一份 status 里取缓存统计；取不到返回 null。
 *
 * 返回 null 而不是零值对象，是因为「上游没报」与「报了个 0」在卡片上必须长得不一样：
 * 前者显示占位符，后者显示真实的 0%。
 */
export function readCacheStats(status: StepCodeStatusDto | null): StepCodeCacheStats | null {
  if (status === null) return null
  const carrier = status as unknown as Record<string, unknown>
  for (const key of CACHE_STATS_KEYS) {
    const candidate = carrier[key]
    const pair = cacheTokenPair(candidate)
    if (pair !== null) {
      const fields = candidate as Record<string, unknown>
      return {
        cacheReadTokens: pair.read,
        missedInputTokens: pair.missed,
        cacheWriteTokens: finiteNumber(fields.cacheWriteTokens) ?? 0,
        requests: finiteNumber(fields.requests) ?? finiteNumber(fields.requestCount),
      }
    }
  }
  return null
}

/**
 * 缓存命中率 = 缓存读入 /（缓存读入 + 未命中输入）。
 *
 * 分母为 0（还没有任何请求，或上游只报了输出 token）时返回 **null**，卡片据此画占位符：
 * 把「没有样本」写成 0% 是谎报——它说的是「一个都没命中」，而事实是「还不知道」。
 */
export function cacheHitRatio(stats: StepCodeCacheStats | null): number | null {
  if (stats === null) return null
  const denominator = stats.cacheReadTokens + stats.missedInputTokens
  if (!Number.isFinite(denominator) || denominator <= 0) return null
  return stats.cacheReadTokens / denominator
}

/** 写侧的线路常量；卡片用它渲染说明，而不是渲染一条永远为 0 的进度条。 */
export const CACHE_WRITE_NOTE = STEP_CODE_CACHE_WRITE_NOTE

export interface StepCodeSectionProps {
  onModelChange?: () => void
}

/** 账号卡片上的一个动作。 */
export type StepCodeAccountAction = 'set-primary' | 'delete' | 'clear-cooldown' | 'relogin'

/** 额度凭据的三种提交方式（对应 host 的 /quota/credential 的 mode）。 */
export type StepCodeQuotaCredentialMode = 'password' | 'manual' | 'clear'

/** 视图可以消费的全部内容，按「会变的事实 / 从答案派生的 / 能触发的」分组。 */
export interface StepCodeSectionView {
  state: {
    status: StepCodeStatusDto | null
    loading: boolean
    busy: string | null
    error: string | null
    connection: StepCodeConnectionDto | null
    adoptResult: StepCodeAdoptResultDto | null
    /** 手工粘贴的 Platform API Key；提交后立即清空，只在这一行的受控输入里存在。 */
    pasteValue: string
    /** 「手工粘贴」与「导入」按哪个 profile 发起。 */
    profile: StepCodeProfile
    /** 手工粘贴兜底是否展开（没有进行中的流程时默认收起）。 */
    pasteOpen: boolean
    contextDrafts: Record<string, string>
    savingModel: string | null
    /** 额度凭据：开放平台账号（非机密）与两条一次性输入。 */
    quotaAccount: string
    quotaPassword: string
    quotaToken: string
  }
  derived: {
    accounts: StepCodeAccountSummaryDto[]
    models: StepCodeModelOption[]
    /** 上下文窗口编辑器的行：只有勾选了的模型才有可覆盖的窗口。 */
    contextModels: StepCodeModelOption[]
    overrideCount: number
    login: StepCodeLoginFlowStatus | null
    quota: StepCodeQuotaSnapshotDto | null
    authenticated: boolean
    poolLabels: AccountPoolLabels
    /** 缓存统计；host 未下发时为 null（卡片显示占位而不是 0%）。 */
    cache: StepCodeCacheStats | null
    /** 缓存命中率；没有样本时为 null。 */
    cacheHitRatio: number | null
    /** 额度凭据的**状态**（有没有、从哪来），不是凭据本身。 */
    quotaCredential: StepCodeQuotaCredentialStatusDto | null
  }
  actions: {
    setProfile(profile: StepCodeProfile): void
    login(profile: StepCodeProfile): Promise<void>
    cancelLogin(): Promise<void>
    submitPaste(): Promise<void>
    setPasteValue(value: string): void
    togglePaste(): void
    adopt(): Promise<void>
    clearAdoptResult(): void
    accountAction(action: StepCodeAccountAction, accountId: string): Promise<void>
    setStrategy(strategy: AccountRotationStrategy): Promise<void>
    toggleModel(modelId: string, enabled: boolean): void
    setAllModels(enabled: boolean): void
    saveContextWindow(modelId: string): Promise<void>
    resetContextWindow(modelId: string): Promise<void>
    resetAllContextWindows(): Promise<void>
    updateContextDraft(modelId: string, draft: string): void
    setDefaultReasoningEffort(effort: StepCodeReasoningEffort | null): Promise<void>
    setCacheRequestParams(enabled: boolean): Promise<void>
    refreshQuota(): Promise<void>
    refreshCatalog(): Promise<void>
    testConnection(): Promise<void>
    setQuotaAccount(value: string): void
    setQuotaPassword(value: string): void
    setQuotaToken(value: string): void
    submitQuotaPassword(): Promise<void>
    submitQuotaToken(): Promise<void>
    clearQuotaCredential(): Promise<void>
  }
}


export function useStepCodeSection({ onModelChange }: StepCodeSectionProps = {}): StepCodeSectionView {
  const t: Translate = fallbackTranslate
  const [status, setStatus] = useState<StepCodeStatusDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<StepCodeConnectionDto | null>(null)
  const [adoptResult, setAdoptResult] = useState<StepCodeAdoptResultDto | null>(null)
  const [pasteValue, setPasteValue] = useState('')
  // 手工粘贴兜底的展开态。功能不删（浏览器打不开时它是唯一出路），只是没有进行中
  // 的流程时不再常年占版面；流程一开始（pending / error）自动展开，结束后自动收起。
  const [pasteOpen, setPasteOpen] = useState(false)
  const [profile, setProfileState] = useState<StepCodeProfile>('step_plan')
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)
  // 额度凭据的两条一次性输入。它们只喂受控 input，提交后立刻清空；
  // 全文件里没有任何其它地方读它们，也没有任何持久化写入。
  const [quotaAccount, setQuotaAccount] = useState('')
  const [quotaPassword, setQuotaPassword] = useState('')
  const [quotaToken, setQuotaToken] = useState('')

  // 用户是否亲手选过 profile。没选过时跟随 host 下发的 status.profile，选过之后
  // 不再被 60 秒一次的静默刷新改回去。
  const profileTouched = useRef(false)
  // 上游在应答背后刷新配额时的补读，一次只挂一个。
  const quotaFollowUp = useRef<QuotaFollowUp | undefined>(undefined)

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setError(null)
    try {
      const next = await get<StepCodeStatusDto>('/status')
      setStatus(next)
      setContextDrafts(contextDraftsFor(next))
      if (!profileTouched.current && isStepCodeProfile(next.profile)) setProfileState(next.profile)
      quotaFollowUp.current ??= createQuotaFollowUp()
      quotaFollowUp.current.observe(next.quotaRefreshing === true, () => { void loadStatus(true) })
    } catch (cause) {
      if (!quiet) setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [])

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
  // 'complete' / 'error' 由这次轮询读到后由 loadStatus 带来的新状态接管。
  const loginStatus = status?.login?.status
  useEffect(() => {
    if (loginStatus !== 'pending') return
    let stopped = false
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const poll = await get<StepCodeLoginFlowStatus>('/login/status')
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

  // 兜底框跟着登录流程的阶段走，而不是跟着「这一页渲染了多久」：
  // pending / error 是用户最需要一个手动出口的两个阶段（此刻才真的能生效）。
  useEffect(() => {
    setPasteOpen(loginStatus === 'pending' || loginStatus === 'error')
  }, [loginStatus])

  const setProfile = useCallback((next: StepCodeProfile) => {
    profileTouched.current = true
    setProfileState(next)
  }, [])

  const login = async (loginProfile: StepCodeProfile): Promise<void> => {
    try {
      setBusy(`login:${loginProfile}`)
      setError(null)
      setConnection(null)
      setPasteValue('')
      const flow = await post<StepCodeLoginFlowStatus>('/login/start', { profile: loginProfile })
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
      await post<StepCodeLoginFlowStatus>('/login/cancel', {})
      await loadStatus(true)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const submitPaste = async (): Promise<void> => {
    const apiKey = pasteValue.trim()
    if (apiKey === '') {
      setError(t('manualPasteEmpty'))
      return
    }
    try {
      setBusy('login-manual')
      setError(null)
      // 这条路由回的是整份 status：兑换成功会写入凭据，账号卡、模型与配额在返回时
      // 就已经过期了。请求体带凭据，刻意不进冻结契约。
      setStatus(await post<StepCodeStatusDto>('/login/manual', { profile, apiKey }))
      setPasteValue('')
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      // 无论成败都不再保留这串 API Key：它已经提交过，或已经被拒了。
      setPasteValue('')
      setBusy(null)
    }
  }

  const adopt = async (): Promise<void> => {
    try {
      setBusy('adopt')
      setError(null)
      // adopt 不带 profile：host 按本机登录态里记录的 profile 判定（区域属于凭据）。
      const result = await post<StepCodeAdoptResultDto>('/adopt', {})
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

  const accountAction = async (action: StepCodeAccountAction, accountId: string): Promise<void> => {
    try {
      setBusy(`account:${action}:${accountId}`)
      setError(null)
      setStatus(await post<StepCodeStatusDto>('/accounts', { action, accountId }))
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
      setStatus(await post<StepCodeStatusDto>('/accounts', { action: 'strategy', strategy }))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  /**
   * 一个模型勾选补丁；host 回整份新状态，卡片因此不必猜哪些 id 最终生效。
   *
   * 语义照计划 §12.1：**缺省或空数组 = 不过滤（全部可用），非空 = 显式选择**。
   * 所以「全不选」提交的是空数组，它的含义是**清除显式选择、回到不过滤**，而不是
   * 「一个模型都不可用」；卡片在按钮旁边也照这句话说明，避免用户按了之后以为坏了。
   */
  const applyEnabledModels = async (enabledModelIds: string[]): Promise<void> => {
    try {
      setError(null)
      const updated = await post<StepCodeStatusDto>('/settings', { enabledModelIds })
      setStatus(updated)
      // 刚勾上的模型还没有草稿，而上下文窗口区只渲染勾选了的模型。
      setContextDrafts(contextDraftsFor(updated))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const toggleModel = (modelId: string, enabled: boolean): void => {
    if (status === null) return
    const current = status.models.filter((model) => model.enabled).map((model) => model.id)
    const next = enabled ? [...new Set([...current, modelId])] : current.filter((id) => id !== modelId)
    void applyEnabledModels(next)
  }

  const setAllModels = (enabled: boolean): void => {
    if (status === null || status.models.length === 0) return
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
      setStatus(await post<StepCodeStatusDto>('/settings', { contextWindowOverrides: { [modelId]: parsed } }))
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
      const updated = await post<StepCodeStatusDto>('/settings', { contextWindowOverrides: { [modelId]: null } })
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
      const updated = await post<StepCodeStatusDto>('/settings', {
        contextWindowOverrides: Object.fromEntries(ids.map((id) => [id, null])),
      })
      setStatus(updated)
      setContextDrafts(contextDraftsFor(updated))
      onModelChange?.()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const setDefaultReasoningEffort = async (effort: StepCodeReasoningEffort | null): Promise<void> => {
    try {
      setBusy('effort')
      setError(null)
      setStatus(await post<StepCodeStatusDto>('/settings', { defaultReasoningEffort: effort }))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  const setCacheRequestParams = async (enabled: boolean): Promise<void> => {
    try {
      setBusy('cache-params')
      setError(null)
      setStatus(await post<StepCodeStatusDto>('/settings', { cacheRequestParams: enabled }))
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
      setStatus(await post<StepCodeStatusDto>('/quota', {}))
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
      setStatus(await post<StepCodeStatusDto>('/catalog/refresh', {}))
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
      setConnection(await post<StepCodeConnectionDto>('/connection/test', {}))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(null)
    }
  }

  /**
   * 额度凭据的三种提交。
   *
   * 三者共用一个出口，好处是「凭据只在请求体里过一趟」这件事只写一遍：mode 决定 host
   * 走哪条路，而 password / token 都由这个函数的局部变量直接进 body，函数返回后 React
   * state 里也已经清空（setState 在 finally 里先跑）。**没有任何一处把它们写进
   * localStorage、URL 或日志**，也没有任何接口能把它们读回来。
   */
  const submitQuotaCredential = async (mode: StepCodeQuotaCredentialMode): Promise<void> => {
    const password = quotaPassword
    const token = quotaToken
    const account = quotaAccount.trim()
    if (mode === 'password' && account === '') {
      setError(t('quotaCredentialAccountEmpty'))
      return
    }
    if (mode === 'password' && password === '') {
      setError(t('quotaCredentialPasswordEmpty'))
      return
    }
    if (mode === 'manual' && token === '') {
      setError(t('quotaCredentialTokenEmpty'))
      return
    }
    try {
      setBusy(`quota-credential:${mode}`)
      setError(null)
      // 秘密只出现在这个对象字面量里，且只作为 POST 体。
      const body = mode === 'password'
        ? { mode, account, password }
        : mode === 'manual' ? { mode, token } : { mode }
      setStatus(await post<StepCodeStatusDto>('/quota/credential', body))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setQuotaPassword('')
      setQuotaToken('')
      setBusy(null)
    }
  }

  const accounts = stepCodeAccounts(status, profile)
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
      profile,
      pasteOpen,
      contextDrafts,
      savingModel,
      quotaAccount,
      quotaPassword,
      quotaToken,
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
      quotaCredential: status?.quotaCredential ?? null,
    },
    actions: {
      setProfile,
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
      setCacheRequestParams,
      refreshQuota,
      refreshCatalog,
      testConnection,
      setQuotaAccount,
      setQuotaPassword,
      setQuotaToken,
      submitQuotaPassword: () => submitQuotaCredential('password'),
      submitQuotaToken: () => submitQuotaCredential('manual'),
      clearQuotaCredential: () => submitQuotaCredential('clear'),
    },
  }
}
